import { DateTime } from 'luxon';
import {
  and,
  eq,
  gte,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type Column,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { conversationEvents, conversations, csatSurveys, metricsDaily } from '@/db/schema';
import { businessMinutesBetween, type HoursConfig } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { defaultHours, ticketHours, type HoursCatalog } from '@/lib/hours/resolve';
import { loadPolicies, type LoadedPolicy } from '@/lib/sla';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { logger } from '@/lib/log';

const log = logger('rollup');

/**
 * One day of figures, computed from the source tables.
 *
 * The nightly job stores what this returns; the live dashboard runs it for
 * today and throws the result away. That sharing is the point: "resolved
 * today" on the dashboard and "resolved" on tomorrow's rollup row are then the
 * same measurement rather than two definitions that drift apart, and a team
 * that watches both never has to work out which one is lying.
 *
 * Four slices are produced per day — the totals, and then by group, by agent
 * and by channel — with null meaning "all" in each dimension. Storing every
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
const FALLBACK_ZONE = TEAM_TIME_ZONE;

/** The schedule a ticket is measured against, given its policy and its group. */
export type HoursFor = (policyId: string | null, groupId: string | null) => HoursConfig | null;

export type ReportingContext = { zone: string; hoursFor: HoursFor };

/**
 * The zone and calendars every day in a run is measured against, read once.
 *
 * Schedules, holidays, group overrides and policies are a dozen rows that every
 * ticket in every day of the window is measured against, so they are loaded
 * whole and up front — by the nightly job for its three days, and by the
 * dashboard for its one.
 */
export async function reportingContext(): Promise<ReportingContext> {
  const [catalog, policies] = await Promise.all([loadHoursCatalog(), loadPolicies()]);

  return { zone: zoneOf(catalog), hoursFor: hoursResolver(catalog, policies) };
}

/**
 * The zone alone, for a live read that needs the team's days and no calendar
 * — the inbox's rated view. From the same memoised catalog as
 * `reportingContext`, so a list and the report beside it cut their days at
 * the same midnight.
 */
export async function reportingZone(): Promise<string> {
  return zoneOf(await loadHoursCatalog());
}

function zoneOf(catalog: HoursCatalog): string {
  return defaultHours(catalog)?.timezone ?? FALLBACK_ZONE;
}

/** The team's current date, which is what "today" means everywhere below. */
export function todayIn(zone: string): string {
  return DateTime.now().setZone(zone).toISODate()!;
}

/**
 * The window a report's range covers, as the `YYYY-MM-DD` the rollup writes.
 *
 * Lives here, beside `todayIn`, because it is the read side of the same rule:
 * the rollup buckets days in the team's zone, so a report that asks for "the
 * last 7 days" against the database's `current_date` selects a window whose
 * edges are two or three hours out — silently including or dropping an evening
 * shift at each end. Every report that filters on `day` goes through this, so a
 * figure and the range printed above it cannot disagree about where the window
 * starts.
 *
 * `to` is today, which never has a rolled-up row: the job clamps to yesterday
 * because today is not complete. Pages say so rather than quietly asking for
 * `days - 1`, since a range that omitted today would read as an off-by-one to
 * anybody comparing it against a calendar.
 */
export function rangeIn(zone: string, days: number): { from: string; to: string } {
  const today = DateTime.now().setZone(zone).startOf('day');

  return {
    from: today.minus({ days: days - 1 }).toISODate()!,
    to: today.toISODate()!,
  };
}

/** A `rangeIn()` window, with the zone its two dates are days in. */
export type ReportWindow = { from: string; to: string; zone: string };

/**
 * A timestamptz falls on one of the window's days, in the team's zone: the
 * `rangeIn()` rule for a live read, never the database's `current_date`,
 * which is UTC's (`docs/PROJECT-STATE.md` §6.52). Each edge is a date's
 * midnight in the zone, so a DST change moves it with the clock, and the
 * end is the midnight after `to`, exclusive.
 */
export function within(column: SQLWrapper, window: ReportWindow): SQL {
  return sql`${column} >= (${window.from}::date)::timestamp at time zone ${window.zone}
    and ${column} < ((${window.to}::date + 1))::timestamp at time zone ${window.zone}`;
}

/**
 * The first day any figure could exist for, as the team's date.
 *
 * A survey or a resolution always belongs to a ticket that predates it, so the
 * oldest ticket is a safe lower bound for the whole archive — which is what
 * lets a backfill say "everything" without an operator having to know when the
 * company started.
 *
 * Filtered to the channels the team actually works, for the same reason
 * `computeDay` is: a read-only channel contributes nothing to any figure, so
 * starting a rebuild at one would just walk empty days.
 *
 * Null when there is nothing countable at all, which is a real answer: there is
 * nothing to rebuild.
 */
export async function earliestDay(zone: string): Promise<string | null> {
  const rows = await db
    .select({ first: sql<string | null>`min(${conversations.createdAt})` })
    .from(conversations)
    .where(
      and(
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
        notInArray(conversations.channel, readOnlyChannels()),
        ne(conversations.sourceSystem, 'import'),
      ),
    );

  const first = rows[0]?.first;
  if (!first) return null;

  return DateTime.fromJSDate(new Date(first), { zone }).toISODate();
}

export type Dimensions = { groupId: string | null; agentId: string | null; channel: string | null };

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

export type Bucket = {
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
  csatSentCount: number;
  csatSkippedCount: number;
  csatRating1: number;
  csatRating2: number;
  csatRating3: number;
  csatRating4: number;
  csatRating5: number;
};

export type Slice = Dimensions & { bucket: Bucket };

/** The bucket column each rating on the 1–5 scale is counted in. */
export const RATING_COLUMNS = [
  'csatRating1',
  'csatRating2',
  'csatRating3',
  'csatRating4',
  'csatRating5',
] as const satisfies readonly (keyof Bucket)[];

export function emptyBucket(): Bucket {
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
    csatSentCount: 0,
    csatSkippedCount: 0,
    csatRating1: 0,
    csatRating2: 0,
    csatRating3: 0,
    csatRating4: 0,
    csatRating5: 0,
  };
}

/**
 * Compute every slice for one day.
 *
 * `until` bounds the window early, which is what makes this usable live: for
 * today it is "now", so the dashboard measures the day so far rather than
 * reading a day that has not happened yet.
 */
export async function computeDay(
  day: string,
  { zone, hoursFor }: ReportingContext,
  until?: Date,
): Promise<Slice[]> {
  const start = DateTime.fromISO(day, { zone });
  if (!start.isValid) {
    log.warn(`ignoring an unparseable day "${day}"`);
    return [];
  }

  const from = start.startOf('day').toJSDate();
  const endOfDay = start.plus({ days: 1 }).startOf('day').toJSDate();
  const to = until && until < endOfDay ? until : endOfDay;

  const buckets = new Map<string, Bucket>();

  /** Adds one fact to the totals and to each single-dimension slice. */
  const add = (dims: Dimensions, apply: (bucket: Bucket) => void) => {
    for (const slice of slicesFor(dims)) apply(bucketFor(buckets, slice));
  };

  const worked = workedConversation();

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
        worked,
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
        worked,
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
        worked,
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
        worked,
      ),
    );

  for (const row of reopened) {
    add(dimsOf(row), (bucket) => {
      bucket.ticketsReopened += 1;
    });
  }

  // --- CSAT -----------------------------------------------------------------
  // One read for the three things a survey can add to a day — it was sent,
  // skipped, or answered — each on its own timestamp (the columns' comment in
  // `db/schema/metrics.ts`), so a survey sent today and answered next week
  // counts once on each day and is re-read by neither.
  const during = (at: Column) => and(gte(at, from), lt(at, to));
  const surveys = await db
    .select({
      status: csatSurveys.status,
      sentAt: csatSurveys.sentAt,
      createdAt: csatSurveys.createdAt,
      respondedAt: csatSurveys.respondedAt,
      rating: csatSurveys.rating,
      agentId: csatSurveys.agentId,
      groupId: csatSurveys.groupId,
      // The survey's own channel, not the ticket's: a merged ticket would
      // otherwise move a score from the channel it was asked on to the one
      // it was merged into. The ticket's only for the one row written before
      // the survey had a channel — without one, a fact would land in the
      // totals and in no channel slice, and `reconciles` would refuse the day.
      channel: sql<string>`coalesce(${csatSurveys.channel}, ${conversations.channel})`,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(
      and(
        or(
          during(csatSurveys.sentAt),
          and(eq(csatSurveys.status, 'skipped'), during(csatSurveys.createdAt)),
          during(csatSurveys.respondedAt),
        ),
        surveyedConversation(),
      ),
    );

  const inDay = (at: Date | null) => at !== null && at >= from && at < to;

  for (const row of surveys) {
    // The agent and group are the survey's own snapshot, not the ticket's
    // current owner: a score belongs to whoever handled it at the time.
    add({ groupId: row.groupId, agentId: row.agentId, channel: row.channel }, (bucket) => {
      if (inDay(row.sentAt)) bucket.csatSentCount += 1;
      if (row.status === 'skipped' && inDay(row.createdAt)) bucket.csatSkippedCount += 1;

      // Only a rating on the scale: every door refuses anything else, and one
      // that got past them would count in the average and in no bar of the
      // distribution, so the two would stop describing the same answers.
      const rating = row.rating;
      if (inDay(row.respondedAt) && rating !== null && Number.isInteger(rating)) {
        const column = RATING_COLUMNS[rating - 1];
        if (column) {
          bucket.csatRatingSum += rating;
          bucket.csatResponseCount += 1;
          bucket[column] += 1;
        }
      }
    });
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const [groupId, agentId, channel] = key.split('|');
    return { groupId: groupId || null, agentId: agentId || null, channel: channel || null, bucket };
  });
}

/**
 * `conversations`, or an alias of it (`alias(conversations, 'rated')`), for
 * `workedConversation` and `surveyedConversation` when they are read inside
 * a subquery over a second copy of the table: written against
 * `conversations` itself there, they would bind to the outer row.
 */
type TicketColumns = Record<'channel' | 'sourceSystem' | 'deletedAt' | 'isSpam', AnyPgColumn>;

/**
 * Conversations the team actually worked, as a condition on `conversations`.
 *
 * Applied to every query in `computeDay` rather than subtracted from the
 * totals afterwards. A read-only channel has no first response and no SLA by
 * construction, so leaving it in would not add a channel row to the report —
 * it would quietly lower the response and resolution rates for every channel
 * that does have them, by counting tickets that could never have either.
 *
 * An imported conversation — a WhatsApp Business app chat copied in after a
 * coexistence onboarding — is out for a sharper reason: its `created_at` is
 * when the customer first wrote on the phone, so it would land as demand on
 * a day already reported, and an agent answering it now would measure a
 * first response in months.
 *
 * Exported for the satisfaction report's live reads, which have to count the
 * same surveys the rollup does or the page's check of one against the other
 * would report a gap that is only two definitions.
 */
export function workedConversation(ticket: TicketColumns = conversations) {
  return and(notInArray(ticket.channel, readOnlyChannels()), ne(ticket.sourceSystem, 'import'));
}

/**
 * A conversation whose surveys count: worked, and neither deleted nor spam —
 * the filter `computeDay`'s created, first-response and resolution reads
 * carry beside `workedConversation()`. A survey is never sent for a ticket in either
 * state, but one deleted or marked spam after its survey went out kept
 * counting, so "Resolutions surveyed" divided sends that included it by
 * resolutions that did not. The satisfaction report's live reads take the
 * same filter, for the reason `workedConversation()` is exported.
 */
export function surveyedConversation(ticket: TicketColumns = conversations) {
  return and(isNull(ticket.deletedAt), eq(ticket.isSpam, false), workedConversation(ticket));
}

/**
 * Whether a day's slices agree with each other.
 *
 * Every countable fact carries a channel — `conversations.channel` is NOT NULL —
 * so each one lands in exactly one channel slice, and the totals row must equal
 * the sum of them. That equality is precisely what the double-counted totals
 * slice broke, and it is cheap enough to assert on every write.
 *
 * Checked rather than assumed because the failure is invisible in the output: a
 * totals row that reads high looks like a busy day, not like a bug.
 */
export function reconciles(slices: Slice[]): boolean {
  const totals = totalsOf(slices);
  const byChannel = slices.filter((slice) => slice.channel !== null);

  const sum = (pick: (bucket: Bucket) => number) =>
    byChannel.reduce((running, slice) => running + pick(slice.bucket), 0);

  return (
    totals.ticketsCreated === sum((b) => b.ticketsCreated) &&
    totals.ticketsResolved === sum((b) => b.ticketsResolved) &&
    totals.ticketsReopened === sum((b) => b.ticketsReopened) &&
    totals.firstResponseCount === sum((b) => b.firstResponseCount) &&
    totals.resolutionCount === sum((b) => b.resolutionCount) &&
    totals.csatResponseCount === sum((b) => b.csatResponseCount) &&
    totals.csatSentCount === sum((b) => b.csatSentCount) &&
    totals.csatSkippedCount === sum((b) => b.csatSkippedCount) &&
    RATING_COLUMNS.every((column) => totals[column] === sum((b) => b[column]))
  );
}

/** The all-dimensions-null slice, which is the one a dashboard leads with. */
export function totalsOf(slices: Slice[]): Bucket {
  const total = slices.find(
    (slice) => slice.groupId === null && slice.agentId === null && slice.channel === null,
  );
  return total?.bucket ?? emptyBucket();
}

/** Slices as `metrics_daily` rows, ready to insert. */
export function asRows(day: string, slices: Slice[]): (typeof metricsDaily.$inferInsert)[] {
  return slices.map((slice) => ({
    day,
    groupId: slice.groupId,
    agentId: slice.agentId,
    channel: slice.channel as (typeof metricsDaily.$inferInsert)['channel'],
    ...slice.bucket,
    computedAt: new Date(),
  }));
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

  const fresh = emptyBucket();
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
