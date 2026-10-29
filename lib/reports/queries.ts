import { DateTime } from 'luxon';
import { and, asc, between, eq, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { share } from '@/lib/charts/scale';
import { agents, groups, metricsDaily, rollupDays, ticketCategories } from '@/db/schema';
import type { Range } from './subcategory-queries';
import { RATING_COLUMNS, type ReportWindow } from './rollup';

/**
 * Read models for the reports page.
 *
 * Every one of these reads `metrics_daily` and nothing else. That is the whole
 * point of the nightly rollup: the page stays fast as the archive grows, and
 * opening it can never put an aggregate over the full message history in front
 * of the database.
 */

export type Totals = {
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

const SUMS = {
  ticketsCreated: sql<number>`coalesce(sum(${metricsDaily.ticketsCreated}), 0)::int`,
  ticketsResolved: sql<number>`coalesce(sum(${metricsDaily.ticketsResolved}), 0)::int`,
  ticketsReopened: sql<number>`coalesce(sum(${metricsDaily.ticketsReopened}), 0)::int`,
  firstResponseSecondsSum: sql<number>`coalesce(sum(${metricsDaily.firstResponseSecondsSum}), 0)::bigint`,
  firstResponseCount: sql<number>`coalesce(sum(${metricsDaily.firstResponseCount}), 0)::int`,
  resolutionSecondsSum: sql<number>`coalesce(sum(${metricsDaily.resolutionSecondsSum}), 0)::bigint`,
  resolutionCount: sql<number>`coalesce(sum(${metricsDaily.resolutionCount}), 0)::int`,
  slaFirstResponseMet: sql<number>`coalesce(sum(${metricsDaily.slaFirstResponseMet}), 0)::int`,
  slaFirstResponseBreached: sql<number>`coalesce(sum(${metricsDaily.slaFirstResponseBreached}), 0)::int`,
  slaResolutionMet: sql<number>`coalesce(sum(${metricsDaily.slaResolutionMet}), 0)::int`,
  slaResolutionBreached: sql<number>`coalesce(sum(${metricsDaily.slaResolutionBreached}), 0)::int`,
  csatRatingSum: sql<number>`coalesce(sum(${metricsDaily.csatRatingSum}), 0)::int`,
  csatResponseCount: sql<number>`coalesce(sum(${metricsDaily.csatResponseCount}), 0)::int`,
  csatSentCount: sql<number>`coalesce(sum(${metricsDaily.csatSentCount}), 0)::int`,
  csatSkippedCount: sql<number>`coalesce(sum(${metricsDaily.csatSkippedCount}), 0)::int`,
  csatRating1: sql<number>`coalesce(sum(${metricsDaily.csatRating1}), 0)::int`,
  csatRating2: sql<number>`coalesce(sum(${metricsDaily.csatRating2}), 0)::int`,
  csatRating3: sql<number>`coalesce(sum(${metricsDaily.csatRating3}), 0)::int`,
  csatRating4: sql<number>`coalesce(sum(${metricsDaily.csatRating4}), 0)::int`,
  csatRating5: sql<number>`coalesce(sum(${metricsDaily.csatRating5}), 0)::int`,
} satisfies Record<keyof Totals, SQL<number>>;

/** Every column of `Totals`, from `SUMS`, which the compiler holds to the type. */
const TOTALS_KEYS = Object.keys(SUMS) as (keyof Totals)[];

/**
 * The window's days, both ends included.
 *
 * Every query below takes the range the page resolved through `rangeIn()`
 * rather than a day count. The count used to become a date here, as the UTC
 * date `days` ago with no upper bound: a window one day longer than its
 * label, and a day early for the first hours of every Cairo morning, which is
 * the `current_date` trap AGENTS.md describes, spelled in JavaScript.
 */
function inRange(range: Range) {
  return between(metricsDaily.day, range.from, range.to);
}

/**
 * The totals slice: every dimension null, all five of them — one row per day
 * (`metrics_daily_slice_key`).
 *
 * One predicate for every reader of the totals, because each slice is the
 * totals row with one dimension filled in (`metrics_daily_one_dimension`), so
 * a predicate that leaves a dimension out also matches that dimension's
 * slices. Leaving out the category is the one that would go unseen: every
 * categorised ticket counted twice in every headline figure — this page, the
 * CSAT page and its export, the dashboard's History — and `reconciles()`
 * cannot see it, since it checks what is written, not what is read. A sixth
 * dimension is added here, once.
 */
export const TOTALS_SLICE = and(
  isNull(metricsDaily.groupId),
  isNull(metricsDaily.agentId),
  isNull(metricsDaily.channel),
  isNull(metricsDaily.categoryId),
);

/**
 * Headline numbers.
 *
 * Read from the totals slice rather than by summing the per-agent rows, which
 * would double-count anything attributed to both an agent and a group.
 */
export async function totals(range: Range): Promise<Totals> {
  const rows = await db
    .select(SUMS)
    .from(metricsDaily)
    .where(and(inRange(range), TOTALS_SLICE));

  return normalise(rows[0]);
}

export type Row = Totals & { label: string };

export async function byAgent(range: Range): Promise<Row[]> {
  const rows = await db
    .select({ label: sql<string>`coalesce(${agents.name}, ${agents.email})`, ...SUMS })
    .from(metricsDaily)
    .innerJoin(agents, eq(agents.id, metricsDaily.agentId))
    .where(and(inRange(range), isNotNull(metricsDaily.agentId)))
    .groupBy(agents.id)
    .orderBy(sql`sum(${metricsDaily.ticketsResolved}) desc`);

  return rows.map((row) => ({ ...normalise(row), label: row.label }));
}

export async function byGroup(range: Range): Promise<Row[]> {
  const rows = await db
    .select({ label: groups.name, ...SUMS })
    .from(metricsDaily)
    .innerJoin(groups, eq(groups.id, metricsDaily.groupId))
    .where(and(inRange(range), isNotNull(metricsDaily.groupId)))
    .groupBy(groups.id)
    .orderBy(sql`sum(${metricsDaily.ticketsResolved}) desc`);

  return rows.map((row) => ({ ...normalise(row), label: row.label }));
}

export async function byChannel(range: Range): Promise<Row[]> {
  const rows = await db
    .select({ label: sql<string>`${metricsDaily.channel}`, ...SUMS })
    .from(metricsDaily)
    .where(and(inRange(range), isNotNull(metricsDaily.channel)))
    .groupBy(metricsDaily.channel)
    .orderBy(sql`sum(${metricsDaily.ticketsCreated}) desc`);

  return rows.map((row) => ({ ...normalise(row), label: row.label }));
}

/**
 * The category slices, one row per category with figures in the window, in
 * the registry's order — `position`, then `key` — rather than by volume as the
 * other breakdowns are: four fixed rows that keep their places from one week
 * to the next can be compared week on week.
 *
 * Each ticket under its category as it stands when its day was rolled up
 * (`lib/reports/rollup.ts` says why). A retired category is not filtered out:
 * its days keep reporting under it, which is what retired-never-deleted is
 * for, and `isActive` comes back so the page names it as retired
 * (`categoryLabel`). The tickets nothing has filed are in no row here; `rest`
 * is the rest of the totals (`uncategorised`).
 *
 * The totals come back from the same statement, because the rest is a
 * subtraction and its two halves must be one moment's. Read apart — `totals()`
 * and this, through `allLimited` — each statement took its own snapshot, and a
 * rollup committing a day between them took one night's category slices off a
 * total that did not yet hold that night, which printed "No category" short,
 * or negative. The rows are `TOTALS_SLICE` or a category slice, which names
 * nothing else (`metrics_daily_one_dimension`), and under the left join the
 * totals are the one group with no registry row: the foreign key is
 * `restrict`, so every category slice finds its row.
 */
export async function byCategory(range: Range): Promise<CategoryBreakdown> {
  const rows = await db
    .select({
      id: ticketCategories.id,
      label: ticketCategories.labelEn,
      isActive: ticketCategories.isActive,
      ...SUMS,
    })
    .from(metricsDaily)
    .leftJoin(ticketCategories, eq(ticketCategories.id, metricsDaily.categoryId))
    .where(and(inRange(range), or(TOTALS_SLICE, isNotNull(metricsDaily.categoryId))))
    .groupBy(ticketCategories.id)
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));

  const categories = rows.flatMap(({ id, label, isActive, ...sums }) =>
    id === null || label === null
      ? []
      : [{ ...normalise(sums), label, isActive: isActive ?? false }],
  );
  return {
    rows: categories,
    rest: uncategorised(normalise(rows.find((row) => row.id === null)), categories),
  };
}

/** The window's category rows, and what no category holds, from one snapshot. */
export type CategoryBreakdown = {
  /** One row per category with a slice in the window, in the registry's order. */
  rows: (Row & { isActive: boolean })[];
  /** The window's totals less every row above. */
  rest: Totals;
};

/**
 * The window's figures that no category slice holds: the totals less every
 * category's, column by column — the tickets nothing had filed when their day
 * was rolled up, and every ticket on a day rolled up before the rollup had a
 * category at all.
 *
 * Exact because a ticket has one category, so no figure is in two category
 * slices, and every column of `Totals` is a count or a sum. Not clamped at
 * zero: the rollup writes no day whose category slices sum past its totals
 * (`reconcileFailure`, asked before the write), and `byCategory` reads both
 * halves in one statement, so a negative here would be a bug, and one worth
 * seeing rather than printing as nothing.
 */
export function uncategorised(total: Totals, rows: readonly Totals[]): Totals {
  return normalise(
    Object.fromEntries(
      TOTALS_KEYS.map((key) => [key, rows.reduce((rest, row) => rest - row[key], total[key])]),
    ),
  );
}

/**
 * The first day with a category slice, on or before the window's end — where
 * the overview's category figures start, so a window opening before it can say
 * that its earlier days are all under "No category" rather than leaving a
 * reader to take them for tickets nobody filed.
 *
 * No lower bound, for the reason `rolledUpDays` gives: a quiet first day in
 * the window would otherwise read as the day category figures began.
 */
export async function categorisedFrom(range: Range): Promise<string | null> {
  const [row] = await db
    .select({ first: sql<string | null>`min(${metricsDaily.day})::text` })
    .from(metricsDaily)
    .where(and(lte(metricsDaily.day, range.to), isNotNull(metricsDaily.categoryId)));

  return row?.first ?? null;
}

/**
 * What the overview says about where its category figures start: `never`, no
 * category slice on or before the window's end; `none-here`, some before the
 * window and none in it; `starts`, the first is after `from`; `whole`, nothing
 * to say. Without a word, a window holding none reads as one whose tickets
 * nobody filed, and one whose category slices begin part-way through reads as
 * a team that started filing that day — when the days before may simply have
 * been rolled up before the rollup had a category to file under.
 *
 * `first` is `categorisedFrom`'s answer, so with no category slice in the
 * window it is null or before the window. `from` is the later of the window's
 * start and the rolled-up history's, so a window the page already says starts
 * late is not told so a second time, as though there were two starts.
 */
export function categoryCoverage(
  rowsInWindow: number,
  first: string | null,
  from: string,
): { kind: 'never' | 'none-here' | 'whole' } | { kind: 'starts'; on: string } {
  if (first === null) return { kind: 'never' };
  if (rowsInWindow === 0) return { kind: 'none-here' };
  return first > from ? { kind: 'starts', on: first } : { kind: 'whole' };
}

/** Daily series for the totals slice, oldest first, for the trend table. */
export async function daily(range: Range): Promise<(Totals & { day: string })[]> {
  const rows = await db
    .select({ day: metricsDaily.day, ...SUMS })
    .from(metricsDaily)
    .where(and(inRange(range), TOTALS_SLICE))
    .groupBy(metricsDaily.day)
    .orderBy(metricsDaily.day);

  return rows.map((row) => ({ ...normalise(row), day: row.day }));
}

/**
 * Where the rollup's history starts, and on how many of the window's days it
 * has figures.
 *
 * The rollup recomputes three days a night and has no backfill, so a window
 * wider than the history returns the same rows as a narrower one and the range
 * control looks broken. The page compares `first` with the window's start to
 * say so.
 *
 * `first` has no lower bound, and that is the point of it. A day nobody worked
 * has no row — `computeDay` writes nothing for an empty day — so the earliest
 * row *inside* the window is later than `from` whenever the window opens on a
 * holiday or a quiet Friday, and the page would say the history begins there
 * when a wider range reaches further back. `days` stays the count inside the
 * window. Read from the totals slice, the one every figure on the page sums.
 */
export async function rolledUpDays(range: Range): Promise<{ first: string | null; days: number }> {
  const [row] = await db
    .select({
      first: sql<string | null>`min(${metricsDaily.day})::text`,
      days: sql<number>`(count(distinct ${metricsDaily.day}) filter (where ${metricsDaily.day} >= ${range.from}::date))::int`,
    })
    .from(metricsDaily)
    .where(and(lte(metricsDaily.day, range.to), TOTALS_SLICE));

  return { first: row?.first ?? null, days: row?.days ?? 0 };
}

/**
 * The newest day before `to` the rollup has computed whole: the newest in
 * `rollup_days` whose computation began after the day ended, in the team's
 * zone. Yesterday once tonight's run has reached it, whether or not anything
 * happened on it; the day before until then; further back after a night the
 * run did not happen. Null while no run since the table existed has computed
 * a day whole. `countedThrough` (`csat-queries.ts`) reads it.
 */
export async function lastWholeDay(window: ReportWindow): Promise<string | null> {
  const [row] = await db
    .select({ day: sql<string | null>`max(${rollupDays.day})::text` })
    .from(rollupDays)
    .where(
      and(
        lt(rollupDays.day, sql`${window.to}::date`),
        sql`${rollupDays.computedAt} >= (${rollupDays.day} + 1)::timestamp at time zone ${window.zone}`,
      ),
    );
  return row?.day ?? null;
}

/**
 * `bigint` sums come back from postgres.js as strings, because a bigint does
 * not always fit a JavaScript number. These are seconds, so they always do —
 * but the string has to be converted or every average silently becomes NaN.
 */
function normalise(row: Partial<Record<keyof Totals, unknown>> | undefined): Totals {
  const value = (key: keyof Totals) => Number(row?.[key] ?? 0) || 0;

  return {
    ticketsCreated: value('ticketsCreated'),
    ticketsResolved: value('ticketsResolved'),
    ticketsReopened: value('ticketsReopened'),
    firstResponseSecondsSum: value('firstResponseSecondsSum'),
    firstResponseCount: value('firstResponseCount'),
    resolutionSecondsSum: value('resolutionSecondsSum'),
    resolutionCount: value('resolutionCount'),
    slaFirstResponseMet: value('slaFirstResponseMet'),
    slaFirstResponseBreached: value('slaFirstResponseBreached'),
    slaResolutionMet: value('slaResolutionMet'),
    slaResolutionBreached: value('slaResolutionBreached'),
    csatRatingSum: value('csatRatingSum'),
    csatResponseCount: value('csatResponseCount'),
    csatSentCount: value('csatSentCount'),
    csatSkippedCount: value('csatSkippedCount'),
    csatRating1: value('csatRating1'),
    csatRating2: value('csatRating2'),
    csatRating3: value('csatRating3'),
    csatRating4: value('csatRating4'),
    csatRating5: value('csatRating5'),
  };
}

// --- Derived figures --------------------------------------------------------
// Kept as functions over a row rather than stored, so "average" is defined once
// and a slice with no data reads as "—" everywhere instead of as a zero.

export function averageSeconds(sum: number, count: number): number | null {
  return count > 0 ? Math.round(sum / count) : null;
}

export function metPercentage(met: number, breached: number): number | null {
  const total = met + breached;
  return total > 0 ? Math.round((met / total) * 100) : null;
}

export function averageRating(sum: number, count: number): number | null {
  return count > 0 ? Math.round((sum / count) * 10) / 10 : null;
}

type RatingColumns = Pick<Totals, (typeof RATING_COLUMNS)[number]>;

/**
 * The answers the distribution holds: every answer on a day rolled up since
 * survey counts were kept, and none on a day rolled up before. Those older
 * days keep their answers in `csat_response_count` alone, beside a send count
 * of 0 that means "not counted", not "none sent" — so anything that sets
 * answers against sends counts these, never `csat_response_count`.
 */
export function ratedCount(row: RatingColumns): number {
  return ratingCounts(row).reduce((sum, count) => sum + count, 0);
}

/**
 * Answers in the window over surveys sent in it. A rate, not a cohort: a link
 * answered three weeks after it went out counts in the week it was answered,
 * so a short window that caught the answers to a busier one before it can
 * read above 100%, and says so rather than being clipped.
 *
 * Over `ratedCount`, so a window reaching back to days rolled up before
 * survey counts were kept divides only the days that kept both: their
 * answers over nothing read as 200%.
 */
export function responseRate(row: Pick<Totals, 'csatSentCount'> & RatingColumns) {
  return share(ratedCount(row), row.csatSentCount);
}

/**
 * The line under a CSAT tile: how many answers its average is over, and what
 * share of the window's surveys they are — the response rate is what says
 * whether an average of 4.6 is the team or the dozen customers who answered.
 * The rate is left off when nothing was sent, rather than printed as 0%, and
 * when the window holds answers from before survey counts were kept: it is
 * then the rate of fewer answers than the count beside it names, and the
 * satisfaction report is where that is said.
 */
export function responsesHint(
  row: Pick<Totals, 'csatResponseCount' | 'csatSentCount'> & RatingColumns,
): string {
  const answers = `${row.csatResponseCount.toLocaleString('en-GB')} response${row.csatResponseCount === 1 ? '' : 's'}`;
  const rate = responseRate(row);
  return rate === null || ratedCount(row) !== row.csatResponseCount
    ? answers
    : `${answers} · ${rate}% of ${row.csatSentCount.toLocaleString('en-GB')} sent`;
}

/**
 * The answers the average counts and the distribution does not, and the days
 * they are on: days rolled up before survey counts were kept, which hold an
 * answer count and a rating sum and nothing else. The page says so, or the
 * average and the bars beside it describe different answers without a word.
 */
export function unsplitAnswers(
  rows: (Pick<Totals, 'csatResponseCount'> & RatingColumns & { day: string })[],
): { answers: number; days: string[] } {
  const days = rows.filter((row) => row.csatResponseCount > ratedCount(row));
  return {
    answers: days.reduce((sum, row) => sum + row.csatResponseCount - ratedCount(row), 0),
    days: days.map((row) => row.day),
  };
}

/**
 * Surveys sent over tickets resolved, in the same window — how much of the
 * work was asked about at all. Also a rate: a survey goes out a delay after
 * its resolve, so the two edges of a window do not hold exactly the same
 * tickets.
 */
export function surveyedRate(row: Pick<Totals, 'csatSentCount' | 'ticketsResolved'>) {
  return share(row.csatSentCount, row.ticketsResolved);
}

/** The answers on each step of the scale, 1 to 5, from the rollup's own list of the columns. */
export function ratingCounts(row: RatingColumns): [number, number, number, number, number] {
  const [one, two, three, four, five] = RATING_COLUMNS;
  return [row[one], row[two], row[three], row[four], row[five]];
}

/**
 * The share of the distribution at 4–5 and at 1–2. Out of the distribution
 * rather than `csat_response_count`: the two are the same answers on every day
 * rolled up since the distribution existed, and on a day rolled up before it
 * only the distribution's own total says how many answers it describes.
 */
export function ratingShares(row: RatingColumns): {
  positive: number | null;
  negative: number | null;
} {
  const [one, two, , four, five] = ratingCounts(row);
  const counted = ratedCount(row);
  return { positive: share(four + five, counted), negative: share(one + two, counted) };
}

/**
 * Every day from `from` to `to`, both included, as the `YYYY-MM-DD` strings
 * the rollup keys on — for a series that has to show the days with no row as
 * days, not skip them. Calendar arithmetic on the dates themselves, never
 * through a `Date`, which would put each one at midnight UTC (AGENTS.md).
 */
export function windowDays(range: Range): string[] {
  const days: string[] = [];
  const last = DateTime.fromISO(range.to, { zone: 'utc' });
  for (
    let day = DateTime.fromISO(range.from, { zone: 'utc' });
    day.isValid && day <= last;
    day = day.plus({ days: 1 })
  ) {
    days.push(day.toISODate()!);
  }
  return days;
}

/**
 * One point per day of `range`, each with its rolled-up row or none — the
 * series every chart over the rollup draws. A day with no row is a real
 * observation, a holiday or a weekend, and dropping it would slide every
 * later bar leftwards, quietly turning a six-day gap into a continuous line;
 * and one helper means every chart labels its days the same way.
 */
export function perDay<T extends { day: string }>(
  range: Range,
  rows: T[],
): { day: string; label: string; row: T | undefined }[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return windowDays(range).map((day) => ({
    day,
    label: DateTime.fromISO(day, { zone: 'utc' }).toFormat('d/M'),
    row: byDay.get(day),
  }));
}

/** "1h 20m", "45s" — a duration a person can read at a glance. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
