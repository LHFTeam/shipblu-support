import { DateTime } from 'luxon';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  businessHours,
  conversationEvents,
  conversations,
  csatSurveys,
  metricsDaily,
} from '@/db/schema';
import { businessMinutesBetween, type HoursConfig } from '@/lib/hours';
import type { ClaimedJob } from '@/lib/queue';
import { loadPolicies } from '@/lib/sla';

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
  const zone = await reportingZone();

  const days = requested
    ? [requested]
    : Array.from({ length: RECOMPUTE_DAYS }, (_, offset) =>
        DateTime.now()
          .setZone(zone)
          .minus({ days: offset + 1 })
          .toISODate()!,
      );

  for (const day of days) {
    const rows = await rollupDay(day, zone);
    console.log(`[rollup_metrics] ${day}: ${rows} rows`);
  }
}

async function reportingZone(): Promise<string> {
  const rows = await db
    .select({ timezone: businessHours.timezone })
    .from(businessHours)
    .orderBy(sql`${businessHours.isDefault} desc`)
    .limit(1);

  return rows[0]?.timezone ?? FALLBACK_ZONE;
}

type Dimensions = { groupId: string | null; agentId: string | null; channel: string | null };

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

async function rollupDay(day: string, zone: string): Promise<number> {
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
    const slices: Dimensions[] = [
      { groupId: null, agentId: null, channel: null },
      { groupId: dims.groupId, agentId: null, channel: null },
      { groupId: null, agentId: dims.agentId, channel: null },
      { groupId: null, agentId: null, channel: dims.channel },
    ];

    for (const slice of slices) {
      // A ticket with no group contributes to the totals but not to a
      // "by group" row, which would otherwise read as a group called null.
      if (slice.groupId === null && slice.agentId === null && slice.channel === null) {
        apply(bucketFor(buckets, slice));
        continue;
      }
      if (slice.groupId ?? slice.agentId ?? slice.channel) apply(bucketFor(buckets, slice));
    }
  };

  const hoursFor = await hoursResolver();

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
    const seconds = elapsedSeconds(hoursFor(row.slaPolicyId), row.createdAt, row.firstRespondedAt!);
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
    const seconds = elapsedSeconds(hoursFor(row.slaPolicyId), row.createdAt, row.resolvedAt!);
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
 * Business hours per SLA policy, resolved once per run.
 *
 * Response times are measured in working time for the same reason the SLA
 * clocks are: a ticket that arrived at 17:01 and was answered at 09:02 was
 * answered in a minute, and a report that calls it sixteen hours is measuring
 * the office being shut.
 */
async function hoursResolver(): Promise<(policyId: string | null) => HoursConfig | null> {
  const policies = await loadPolicies();
  const byPolicy = new Map(policies.map((policy) => [policy.id, policy.hours]));

  const rows = await db
    .select({ schedule: businessHours.schedule, timezone: businessHours.timezone })
    .from(businessHours)
    .orderBy(sql`${businessHours.isDefault} desc`)
    .limit(1);

  const fallback: HoursConfig | null = rows[0]
    ? { schedule: rows[0].schedule, timezone: rows[0].timezone }
    : null;

  // A ticket with no policy still gets measured against the office's hours;
  // otherwise the same overnight wait would count differently depending on
  // whether anyone had configured an SLA for it.
  return (policyId) => (policyId ? (byPolicy.get(policyId) ?? fallback) : fallback);
}

function elapsedSeconds(hours: HoursConfig | null, from: Date, to: Date): number {
  if (!hours) return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  return Math.round(businessMinutesBetween(hours, from, to) * 60);
}
