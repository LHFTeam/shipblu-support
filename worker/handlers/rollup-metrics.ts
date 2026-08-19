import { DateTime } from 'luxon';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, csatSurveys, metricsDaily } from '@/db/schema';
import { businessMinutesBetween, type HoursConfig } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { defaultHours, ticketHours, type HoursCatalog } from '@/lib/hours/resolve';
import type { ClaimedJob } from '@/lib/queue';
import { loadPolicies, type LoadedPolicy } from '@/lib/sla';

/**
 * Nightly rollup into `metrics_daily`. The reports page reads only from here,
 * so opening it never runs an aggregate across the whole message history.
 *
 * Four slices are stored per day — the totals, and then by group, by agent and
 * by channel — with null meaning "all" in each dimension. Storing every
 * combination instead would multiply the row count for cuts nobody asks for;
 * these four are the questions a support team actually has.
 */

/**
 * Days are the team's days, not UTC days.
 *
 * A report where "yesterday" ends at 2am Cairo would put the last two hours of
 * every evening shift on the wrong date, which is exactly the sort of quiet
 * wrongness that makes a team stop trusting a dashboard.
 *
 * The day boundaries come from the default schedule's zone, and deliberately
 * from that one zone even though groups may keep their own. `metrics_daily`
 * has a single `day` per row, so bucketing a group's tickets by its own midnight
 * would mean the totals no longer equalled the sum of the slices. Which hours
 * *count* is per group; which day a ticket lands on is the company's.
 */
const FALLBACK_ZONE = 'Africa/Cairo';

/**
 * How many days each run recomputes.
 *
 * Not just yesterday: a survey answered on Tuesday about a Monday ticket, or a
 * ticket resolved days after it arrived, both change an earlier day's numbers.
 * Recomputing a short window is cheaper than being subtly wrong for good.
 */
const RECOMPUTE_DAYS = 3;

export async function rollupMetrics(job?: ClaimedJob): Promise<void> {
  const requested = (job?.payload as { day?: string } | undefined)?.day;

  // Schedules, holidays, group overrides and policies read once for the whole
  // run rather than once per day: they are a dozen rows that every ticket in
  // every day of the window is measured against.
  const [catalog, policies] = await Promise.all([loadHoursCatalog(), loadPolicies()]);
  const zone = defaultHours(catalog)?.timezone ?? FALLBACK_ZONE;
  const hoursFor = hoursResolver(catalog, policies);

  const days = requested
    ? [requested]
    : Array.from({ length: RECOMPUTE_DAYS }, (_, offset) =>
        DateTime.now()
          .setZone(zone)
          .minus({ days: offset + 1 })
          .toISODate()!,
      );

  for (const day of days) {
    const rows = await rollupDay(day, zone, hoursFor);
    console.log(`[rollup_metrics] ${day}: ${rows} rows`);
  }
}

type Dimensions = { groupId: string | null; agentId: string | null; channel: string | null };

/**
 * The rows one ticket's numbers belong in: the totals, plus one row per
 * dimension the ticket actually has.
 *
 * A ticket with no assignee counts in the totals but not in a "by agent" row,
 * which would otherwise read as an agent called null. Exported because getting
 * this wrong is invisible in the output — it inflates every figure rather than
 * producing an obviously broken one — so it is worth a test of its own.
 */
export function slicesFor(dims: Dimensions): Dimensions[] {
  const slices: Dimensions[] = [{ groupId: null, agentId: null, channel: null }];

  if (dims.groupId) slices.push({ groupId: dims.groupId, agentId: null, channel: null });
  if (dims.agentId) slices.push({ groupId: null, agentId: dims.agentId, channel: null });
  if (dims.channel) slices.push({ groupId: null, agentId: null, channel: dims.channel });

  return slices;
}

type Bucket = {
  ticketsCreated: number;
  ticketsResolved: number;
  ticketsReopened: number;
  firstResponseSecondsSum: number;
  firstResponseCount: number;
  resolutionSecondsSum: number;
  resolutionCount: number;
  slaFirstResponseMet: number;
  slaFirstResponseBreached: number;
  slaResolutionMet: number;
  slaResolutionBreached: number;
  csatRatingSum: number;
  csatResponseCount: number;
};

function empty(): Bucket {
  return {
    ticketsCreated: 0,
    ticketsResolved: 0,
    ticketsReopened: 0,
    firstResponseSecondsSum: 0,
    firstResponseCount: 0,
    resolutionSecondsSum: 0,
    resolutionCount: 0,
    slaFirstResponseMet: 0,
    slaFirstResponseBreached: 0,
    slaResolutionMet: 0,
    slaResolutionBreached: 0,
    csatRatingSum: 0,
    csatResponseCount: 0,
  };
}

/** The schedule a ticket is measured against, given its policy and its group. */
type HoursFor = (policyId: string | null, groupId: string | null) => HoursConfig | null;

async function rollupDay(day: string, zone: string, hoursFor: HoursFor): Promise<number> {
  const start = DateTime.fromISO(day, { zone });
  if (!start.isValid) {
    console.warn(`[rollup_metrics] ignoring an unparseable day "${day}"`);
    return 0;
  }

  const from = start.startOf('day').toJSDate();
  const to = start.plus({ days: 1 }).startOf('day').toJSDate();

  const buckets = new Map<string, Bucket>();

  /** Adds one fact to the totals and to each single-dimension slice. */
  const add = (dims: Dimensions, apply: (bucket: Bucket) => void) => {
    for (const slice of slicesFor(dims)) apply(bucketFor(buckets, slice));
  };

  // --- Created --------------------------------------------------------------
  const created = await db
    .select({
      channel: conversations.channel,
      groupId: conversations.groupId,
      agentId: conversations.assigneeAgentId,
    })
    .from(conversations)
    .where(
      and(
        gte(conversations.createdAt, from),
        lt(conversations.createdAt, to),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
      ),
    );

  for (const row of created) {
    add(dimsOf(row), (bucket) => {
      bucket.ticketsCreated += 1;
    });
  }

  // --- First responses ------------------------------------------------------
  const responded = await db
    .select({
      channel: conversations.channel,
      groupId: conversations.groupId,
      agentId: conversations.assigneeAgentId,
      createdAt: conversations.createdAt,
      firstRespondedAt: conversations.firstRespondedAt,
      firstResponseDueAt: conversations.firstResponseDueAt,
      slaPolicyId: conversations.slaPolicyId,
    })
    .from(conversations)
    .where(
      and(
        gte(conversations.firstRespondedAt, from),
        lt(conversations.firstRespondedAt, to),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
      ),
    );

  for (const row of responded) {
    const seconds = elapsedSeconds(
      hoursFor(row.slaPolicyId, row.groupId),
      row.createdAt,
      row.firstRespondedAt!,
    );
    const met = row.firstResponseDueAt
      ? row.firstRespondedAt!.getTime() <= row.firstResponseDueAt.getTime()
      : null;

    add(dimsOf(row), (bucket) => {
      bucket.firstResponseSecondsSum += seconds;
      bucket.firstResponseCount += 1;
      if (met === true) bucket.slaFirstResponseMet += 1;
      if (met === false) bucket.slaFirstResponseBreached += 1;
    });
  }

  // --- Resolutions ----------------------------------------------------------
  const resolved = await db
    .select({
      channel: conversations.channel,
      groupId: conversations.groupId,
      agentId: conversations.assigneeAgentId,
      createdAt: conversations.createdAt,
      resolvedAt: conversations.resolvedAt,
      resolutionDueAt: conversations.resolutionDueAt,
      slaPolicyId: conversations.slaPolicyId,
    })
    .from(conversations)
    .where(
      and(
        gte(conversations.resolvedAt, from),
        lt(conversations.resolvedAt, to),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
      ),
    );

  for (const row of resolved) {
    const seconds = elapsedSeconds(
      hoursFor(row.slaPolicyId, row.groupId),
      row.createdAt,
      row.resolvedAt!,
    );
    const met = row.resolutionDueAt
      ? row.resolvedAt!.getTime() <= row.resolutionDueAt.getTime()
      : null;

    add(dimsOf(row), (bucket) => {
      bucket.ticketsResolved += 1;
      bucket.resolutionSecondsSum += seconds;
      bucket.resolutionCount += 1;
      if (met === true) bucket.slaResolutionMet += 1;
      if (met === false) bucket.slaResolutionBreached += 1;
    });
  }

  // --- Reopenings -----------------------------------------------------------
  // Counted from the event log rather than from `reopen_count`, which is a
  // running total and cannot say which day a reopening happened on.
  const reopened = await db
    .select({
      channel: conversations.channel,
      groupId: conversations.groupId,
      agentId: conversations.assigneeAgentId,
    })
    .from(conversationEvents)
    .innerJoin(conversations, eq(conversations.id, conversationEvents.conversationId))
    .where(
      and(
        eq(conversationEvents.type, 'reopened'),
        gte(conversationEvents.createdAt, from),
        lt(conversationEvents.createdAt, to),
      ),
    );

  for (const row of reopened) {
    add(dimsOf(row), (bucket) => {
      bucket.ticketsReopened += 1;
    });
  }

  // --- CSAT -----------------------------------------------------------------
  const surveys = await db
    .select({
      rating: csatSurveys.rating,
      agentId: csatSurveys.agentId,
      groupId: csatSurveys.groupId,
      channel: conversations.channel,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(gte(csatSurveys.respondedAt, from), lt(csatSurveys.respondedAt, to)));

  for (const row of surveys) {
    if (row.rating === null) continue;
    // The agent and group are the survey's own snapshot, not the ticket's
    // current owner: a score belongs to whoever handled it at the time.
    add({ groupId: row.groupId, agentId: row.agentId, channel: row.channel }, (bucket) => {
      bucket.csatRatingSum += row.rating!;
      bucket.csatResponseCount += 1;
    });
  }

  // --- Write ----------------------------------------------------------------
  // Delete-then-insert rather than an upsert on the unique index: Postgres
  // treats NULLs as distinct in a unique index, so the "all" slices — which are
  // mostly NULLs — would never conflict and would accumulate a duplicate row on
  // every recompute.
  const rows = [...buckets.entries()].map(([key, bucket]) => {
    const [groupId, agentId, channel] = key.split('|');
    return {
      day,
      groupId: groupId || null,
      agentId: agentId || null,
      channel: (channel || null) as (typeof metricsDaily.$inferInsert)['channel'],
      ...bucket,
      computedAt: new Date(),
    };
  });

  await db.transaction(async (tx) => {
    await tx.delete(metricsDaily).where(eq(metricsDaily.day, day));
    if (rows.length) await tx.insert(metricsDaily).values(rows);
  });

  return rows.length;
}

function dimsOf(row: {
  channel: string;
  groupId: string | null;
  agentId: string | null;
}): Dimensions {
  return { groupId: row.groupId, agentId: row.agentId, channel: row.channel };
}

function bucketFor(buckets: Map<string, Bucket>, dims: Dimensions): Bucket {
  const key = `${dims.groupId ?? ''}|${dims.agentId ?? ''}|${dims.channel ?? ''}`;
  const existing = buckets.get(key);
  if (existing) return existing;

  const fresh = empty();
  buckets.set(key, fresh);
  return fresh;
}

/**
 * The working hours a given ticket is measured against, resolved once per run.
 *
 * Response times are measured in working time for the same reason the SLA
 * clocks are: a ticket that arrived at 17:01 and was answered at 09:02 was
 * answered in a minute, and a report that calls it sixteen hours is measuring
 * the office being shut.
 *
 * Keyed on the group as well as the policy, and through the same resolver the
 * SLA engine uses, so a team with its own operating days and holidays is
 * reported on its own calendar — and reported the same way its due dates were
 * computed. A ticket whose policy has since been deleted still gets measured
 * against its group's hours rather than falling back to wall-clock time.
 */
function hoursResolver(catalog: HoursCatalog, policies: LoadedPolicy[]): HoursFor {
  const byPolicy = new Map(policies.map((policy) => [policy.id, policy]));

  return (policyId, groupId) =>
    ticketHours(catalog, groupId, (policyId ? byPolicy.get(policyId) : null) ?? null);
}

function elapsedSeconds(hours: HoursConfig | null, from: Date, to: Date): number {
  if (!hours) return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  return Math.round(businessMinutesBetween(hours, from, to) * 60);
}
