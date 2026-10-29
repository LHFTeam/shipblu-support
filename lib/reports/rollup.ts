import { DateTime } from 'luxon';
import {
  and,
  eq,
  gte,
  isNotNull,
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
import { accountableOrAssigneeAt } from '@/lib/tickets/accountable';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { dayWindow } from '@/lib/hours/wall-clock';
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
 * Five slices are produced per day — the totals, and then by group, by agent,
 * by channel and by category — with null meaning "all" in each dimension, and
 * no row naming two (`metrics_daily_one_dimension`). Storing every combination
 * instead would multiply the row count for cuts nobody asks for; these five are
 * the questions a support team actually has.
 *
 * The agent a ticket's figures belong to is the one its SLA counted against
 * when each happened (`accountableOrAssigneeAt`): the owner of the WhatsApp
 * number it arrived on at that moment, and otherwise whoever holds it. Every
 * ticket figure in that slice — created, first response, resolved, reopened,
 * met and breached — is filed that way, so the "First response" and "Within
 * SLA" columns beside each other still describe the same tickets. Read as of
 * the figure's own instant rather than from the column, so a handover does not
 * re-file the days before it when the nightly run rebuilds them. Surveys are
 * the exception: a score is the survey's own snapshot of who handled the
 * ticket.
 *
 * The category is read the other way: a ticket's figures are filed under its
 * category as it stands when the day is rolled up (`conversations.category_id`),
 * every figure alike, and a survey under the category of the ticket it is on,
 * since `csat_surveys` keeps none of its own. That is the rule the group
 * already follows, and the report draws the two side by side, so a ticket
 * handed to another team and re-filed reads as one ticket in both tables. Not
 * as of each figure's instant, as the agent is, for three reasons. A category
 * charges nobody, and fairness to a person was the only reason the agent is
 * frozen. A person's correction is the ground truth Jev is graded against, so
 * a rebuild should take it up rather than keep the guess it replaced. And as
 * of its creation every ticket had no category at all: `CHANGE_STAMP` stamps
 * even `createTicket`'s own `category_changed` after the row's `created_at`,
 * so a created figure filed that way would be under no category for every
 * ticket, and a backlog filed afterwards (`backfill_category_ai mode=apply`)
 * would never appear on its own days.
 *
 * What that costs is a drift, bounded, and the one the group already has. The
 * nightly run recomputes three days, so a relabel moves those days' figures
 * with the ticket; an older day moves only when somebody rebuilds it with
 * `rollup_metrics from=`, and until then still files the ticket where it was.
 * And a ticket relabelled after its first response is filed under its new
 * category with the "Within SLA" verdict of the policy its old one chose,
 * since the policy follows the category only until somebody answers. A ticket
 * nothing has filed is in the totals and in no category slice, so "no
 * category" is the totals less the category slices — never negative, because
 * the nightly job writes no day whose category slices sum past its totals
 * (`reconcileFailure`, asked before the write), and `byCategory` reads the
 * totals and the categories in one statement.
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
 * The date an instant falls on in `zone`, as the `YYYY-MM-DD` a report prints.
 *
 * `at.toISOString().slice(0, 10)` is the obvious spelling and it is the UTC
 * date: anything that happened in Cairo before 02:00 — 03:00 under daylight
 * saving — prints as the day before, which is the evening shift's last messages
 * and the night's first, on a date nobody received them. The zone is the
 * caller's: the reporting zone where the date is a report's day, as
 * `earliestDay` below, and `TEAM_TIME_ZONE` where it sits beside timestamps the
 * console draws.
 *
 * Throws on a zone luxon cannot read rather than asserting the null away. The
 * reporting zone comes from `business_hours.timezone`, which only the hours form
 * checks, and a null typed as a string draws as an empty cell — or, through
 * `earliestDay`, reads as an archive with nothing to rebuild — with no line in
 * any log to say why.
 */
export function dateIn(at: Date, zone: string): string {
  const date = DateTime.fromJSDate(at, { zone }).toISODate();
  if (!date) throw new Error(`no date for ${String(at)} in time zone '${zone}'`);
  return date;
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

  return dateIn(new Date(first), zone);
}

/**
 * What a slice is keyed on, in the order a day's slices list them.
 *
 * The type below is made from this list rather than written beside it,
 * because the list is what the bucket key, the totals test and the round trip
 * back into a `Slice` all read: a dimension the type names and they did not
 * would be one a fact could be filed under and the key could not tell apart,
 * and a category slice keyed without its category is the totals' own key —
 * every categorised fact counted in the totals twice.
 */
const DIMENSIONS = ['groupId', 'agentId', 'channel', 'categoryId'] as const;

type Dimension = (typeof DIMENSIONS)[number];

export type Dimensions = Record<Dimension, string | null>;

/**
 * Each dimension's column on `metrics_daily`, held to `DIMENSIONS` by the
 * type: a dimension added to the list and not here does not compile. Every
 * read of a slice is built from it (`sliceWhere`), so it cannot name one
 * dimension fewer than the rollup writes — the way a totals read came to
 * count every categorised ticket twice, which `reconcileFailure` cannot see,
 * since it checks what is written, not what is read.
 */
const SLICE_COLUMNS = {
  groupId: metricsDaily.groupId,
  agentId: metricsDaily.agentId,
  channel: metricsDaily.channel,
  categoryId: metricsDaily.categoryId,
} satisfies Record<Dimension, AnyPgColumn>;

/**
 * The rows of one slice of `metrics_daily`: `named` set and every other
 * dimension null, or every one null for the totals. A row names one dimension
 * at most (`metrics_daily_one_dimension`), but each null is stated anyway, so
 * the predicate is the whole definition rather than half of one that holds
 * only while that CHECK does.
 */
export function sliceWhere(named: Dimension | null): SQL {
  return and(
    ...DIMENSIONS.map((name) =>
      name === named ? isNotNull(SLICE_COLUMNS[name]) : isNull(SLICE_COLUMNS[name]),
    ),
  )!;
}

/** The totals slice: "all" in every dimension. */
const ALL: Dimensions = { groupId: null, agentId: null, channel: null, categoryId: null };

/**
 * The rows one ticket's numbers belong in: the totals, plus one row per
 * dimension the ticket actually has, each naming that dimension alone.
 *
 * A ticket nobody is accountable for and nobody holds counts in the totals but
 * not in a "by agent" row, which would otherwise read as an agent called null;
 * one nothing has filed is in no "by category" row for the same reason.
 * Exported because getting this wrong is invisible in the output — it inflates
 * every figure rather than producing an obviously broken one — so it is worth
 * a test of its own.
 */
export function slicesFor(dims: Dimensions): Dimensions[] {
  const slices: Dimensions[] = [{ ...ALL }];

  if (dims.groupId) slices.push({ ...ALL, groupId: dims.groupId });
  if (dims.agentId) slices.push({ ...ALL, agentId: dims.agentId });
  if (dims.channel) slices.push({ ...ALL, channel: dims.channel });
  if (dims.categoryId) slices.push({ ...ALL, categoryId: dims.categoryId });

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

export type SliceAccumulator = {
  add: (dims: Dimensions, apply: (bucket: Bucket) => void) => void;
  slices: () => Slice[];
};

/**
 * Gathers a day's facts into its slices: each fact `add`ed once, with the
 * dimensions of the ticket it is about, counts in the totals and in every
 * slice `slicesFor` names for it.
 *
 * Each slice is kept whole in the map, dimensions beside its bucket, so what
 * comes out is what went in. The dimensions used to be read back out of the
 * key with `key.split('|')`, and a split that names one segment fewer than the
 * key holds hands every category slice back as a second all-null slice: two
 * totals rows on the day, both summed by every reader, which the reconcile
 * could not see while it compared only the first against the channels (it
 * counts them now, before the job writes, and `metrics_daily_slice_key`
 * refuses the second at insert besides).
 * Exported so the round trip is tested without Postgres.
 */
export function sliceAccumulator(): SliceAccumulator {
  const slices = new Map<string, Slice>();

  const sliceFor = (dims: Dimensions): Slice => {
    // Every dimension, from the list the type is made of, and null kept apart
    // from any string a dimension could hold.
    const key = JSON.stringify(DIMENSIONS.map((name) => dims[name]));
    const existing = slices.get(key);
    if (existing) return existing;

    const fresh: Slice = { ...dims, bucket: emptyBucket() };
    slices.set(key, fresh);
    return fresh;
  };

  return {
    add: (dims, apply) => {
      for (const slice of slicesFor(dims)) apply(sliceFor(slice).bucket);
    },
    slices: () => [...slices.values()],
  };
}

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
  const window = dayWindow(day, zone);
  if (!window) {
    log.warn(`ignoring an unparseable day "${day}"`);
    return [];
  }

  const { start: from, end: endOfDay } = window;
  const to = until && until < endOfDay ? until : endOfDay;

  const { add, slices } = sliceAccumulator();

  const worked = workedConversation();

  // --- Created --------------------------------------------------------------
  const created = await db
    .select({
      channel: conversations.channel,
      groupId: conversations.groupId,
      agentId: accountableOrAssigneeAt(conversations.createdAt),
      categoryId: conversations.categoryId,
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
      agentId: accountableOrAssigneeAt(conversations.firstRespondedAt),
      categoryId: conversations.categoryId,
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
      agentId: accountableOrAssigneeAt(conversations.resolvedAt),
      categoryId: conversations.categoryId,
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
      agentId: accountableOrAssigneeAt(conversationEvents.createdAt),
      categoryId: conversations.categoryId,
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
      // totals and in no channel slice, and `reconcileFailure` would refuse the day.
      channel: sql<string>`coalesce(${csatSurveys.channel}, ${conversations.channel})`,
      // The ticket's, as it stands: a survey keeps no category of its own, and
      // the header says why the current one is what every figure reads — so a
      // score and the resolution it was asked about are in one category.
      // Filed so that every column of a category slice is one partition and
      // "No category" is exact, and drawn nowhere, for that reason: a score
      // that moves with a relabel is not the survey's own figure.
      categoryId: conversations.categoryId,
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
    add(dimsOf(row), (bucket) => {
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

  return slices();
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
 * Why a day's slices disagree with each other, completing "totals do not match
 * …", or null when they agree. The nightly job asks this of a day's slices before it writes them, and
 * writes nothing for a day that fails, logging this so its one line says which
 * rule the day broke.
 *
 * Three rules, each one a bug that is invisible in the output — a totals row
 * that reads high looks like a busy day, not like a bug — and each cheap
 * enough to assert on every write:
 *
 * - **One totals row.** `totalsOf` reads the first slice with every dimension
 *   null, so a second one — a category slice that lost its category on the
 *   way back out of the accumulator — is never compared with anything, and
 *   every reader sums both. The nightly job asks this before it writes, so the
 *   day is refused here, in words, and not written. `metrics_daily_slice_key`
 *   would refuse the same rows at insert, but only as a duplicate key naming no
 *   slice; it stays as the backstop for a writer that does not ask.
 * - **The totals are the sum of the channel slices.** Every countable fact
 *   carries a channel — `conversations.channel` is NOT NULL — so each one lands
 *   in exactly one channel slice. That equality is precisely what the
 *   double-counted totals slice broke. Group, agent and category slices have no
 *   channel, so they are not in the sum, as they must not be: an unassigned
 *   ticket is in no agent slice, and an unfiled one in no category slice.
 * - **No column of the category slices sums past the totals.** A ticket has
 *   one category or none, so a fact is in at most one category slice, and every
 *   column is a count or a sum of non-negative figures. Not an equality,
 *   because a ticket nothing has filed is in none; a sum above the totals is a
 *   fact filed twice, and would make the report's "no category" row negative.
 */
export function reconcileFailure(slices: Slice[]): string | null {
  const totalsRows = slices.filter(isTotals).length;
  if (totalsRows > 1) return `each other: ${totalsRows} slices name no dimension`;

  const totals = totalsOf(slices);
  const sumOf = (rows: Slice[], pick: (bucket: Bucket) => number) =>
    rows.reduce((running, slice) => running + pick(slice.bucket), 0);

  const byChannel = slices.filter((slice) => slice.channel !== null);
  const sum = (pick: (bucket: Bucket) => number) => sumOf(byChannel, pick);
  const channelsAgree =
    totals.ticketsCreated === sum((b) => b.ticketsCreated) &&
    totals.ticketsResolved === sum((b) => b.ticketsResolved) &&
    totals.ticketsReopened === sum((b) => b.ticketsReopened) &&
    totals.firstResponseCount === sum((b) => b.firstResponseCount) &&
    totals.resolutionCount === sum((b) => b.resolutionCount) &&
    totals.csatResponseCount === sum((b) => b.csatResponseCount) &&
    totals.csatSentCount === sum((b) => b.csatSentCount) &&
    totals.csatSkippedCount === sum((b) => b.csatSkippedCount) &&
    RATING_COLUMNS.every((column) => totals[column] === sum((b) => b[column]));
  if (!channelsAgree) return 'the sum of the channel slices';

  const byCategory = slices.filter((slice) => slice.categoryId !== null);
  const over = BUCKET_COLUMNS.find(
    (column) => sumOf(byCategory, (b) => b[column]) > totals[column],
  );
  if (over) return `the category slices, which sum past them in ${over}`;

  return null;
}

/** Every column of a bucket, from the one place that lists them all. */
const BUCKET_COLUMNS = Object.keys(emptyBucket()) as (keyof Bucket)[];

/** "All" in every dimension, read from the list the type is made of. */
function isTotals(slice: Dimensions): boolean {
  return DIMENSIONS.every((name) => slice[name] === null);
}

/** The all-dimensions-null slice, which is the one a dashboard leads with. */
export function totalsOf(slices: Slice[]): Bucket {
  return slices.find(isTotals)?.bucket ?? emptyBucket();
}

/** Slices as `metrics_daily` rows, ready to insert. */
export function asRows(day: string, slices: Slice[]): (typeof metricsDaily.$inferInsert)[] {
  return slices.map((slice) => ({
    day,
    groupId: slice.groupId,
    agentId: slice.agentId,
    channel: slice.channel as (typeof metricsDaily.$inferInsert)['channel'],
    categoryId: slice.categoryId,
    ...slice.bucket,
    computedAt: new Date(),
  }));
}

function dimsOf(row: {
  channel: string;
  groupId: string | null;
  agentId: string | null;
  categoryId: string | null;
}): Dimensions {
  return {
    groupId: row.groupId,
    agentId: row.agentId,
    channel: row.channel,
    categoryId: row.categoryId,
  };
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
