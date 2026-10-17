import { DateTime } from 'luxon';
import { and, between, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, groups, metricsDaily } from '@/db/schema';
import type { Range } from './category-queries';

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
};

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
 * Headline numbers.
 *
 * Read from the totals slice — every dimension null — rather than by summing
 * the per-agent rows, which would double-count anything attributed to both an
 * agent and a group.
 */
export async function totals(range: Range): Promise<Totals> {
  const rows = await db
    .select(SUMS)
    .from(metricsDaily)
    .where(
      and(
        inRange(range),
        isNull(metricsDaily.groupId),
        isNull(metricsDaily.agentId),
        isNull(metricsDaily.channel),
      ),
    );

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

/** Daily series for the totals slice, oldest first, for the trend table. */
export async function daily(range: Range): Promise<(Totals & { day: string })[]> {
  const rows = await db
    .select({ day: metricsDaily.day, ...SUMS })
    .from(metricsDaily)
    .where(
      and(
        inRange(range),
        isNull(metricsDaily.groupId),
        isNull(metricsDaily.agentId),
        isNull(metricsDaily.channel),
      ),
    )
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
 *
 * `last` is the newest day with a row: the newest day anybody worked that
 * the rollup has reached, which is not the newest day it has reached, since
 * an empty day leaves no row. `countedThrough` (`csat-queries.ts`) says what
 * can and cannot be told from it.
 */
export async function rolledUpDays(
  range: Range,
): Promise<{ first: string | null; last: string | null; days: number }> {
  const [row] = await db
    .select({
      first: sql<string | null>`min(${metricsDaily.day})::text`,
      last: sql<string | null>`max(${metricsDaily.day})::text`,
      days: sql<number>`(count(distinct ${metricsDaily.day}) filter (where ${metricsDaily.day} >= ${range.from}::date))::int`,
    })
    .from(metricsDaily)
    .where(
      and(
        lte(metricsDaily.day, range.to),
        isNull(metricsDaily.groupId),
        isNull(metricsDaily.agentId),
        isNull(metricsDaily.channel),
      ),
    );

  return { first: row?.first ?? null, last: row?.last ?? null, days: row?.days ?? 0 };
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

/** A whole percentage of `of`, or null when there is nothing to divide by. */
function share(part: number, of: number): number | null {
  return of > 0 ? Math.round((part / of) * 100) : null;
}

/**
 * Answers in the window over surveys sent in it. A rate, not a cohort: a link
 * answered three weeks after it went out counts in the week it was answered,
 * so a short window that caught the answers to a busier one before it can
 * read above 100%, and says so rather than being clipped.
 */
export function responseRate(row: Pick<Totals, 'csatResponseCount' | 'csatSentCount'>) {
  return share(row.csatResponseCount, row.csatSentCount);
}

/**
 * The line under a CSAT tile: how many answers its average is over, and what
 * share of the window's surveys they are — the response rate is what says
 * whether an average of 4.6 is the team or the dozen customers who answered.
 * The rate is left off when nothing was sent, rather than printed as 0%.
 */
export function responsesHint(row: Pick<Totals, 'csatResponseCount' | 'csatSentCount'>): string {
  const answers = `${row.csatResponseCount.toLocaleString('en-GB')} response${row.csatResponseCount === 1 ? '' : 's'}`;
  const rate = responseRate(row);
  return rate === null
    ? answers
    : `${answers} · ${rate}% of ${row.csatSentCount.toLocaleString('en-GB')} sent`;
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

/** The answers on each step of the scale, 1 to 5. */
export function ratingCounts(row: Totals): [number, number, number, number, number] {
  return [row.csatRating1, row.csatRating2, row.csatRating3, row.csatRating4, row.csatRating5];
}

/**
 * The share of the distribution at 4–5 and at 1–2. Out of the distribution
 * rather than `csat_response_count`: the two are the same answers on every day
 * rolled up since the distribution existed, and on a day rolled up before it
 * only the distribution's own total says how many answers it describes.
 */
export function ratingShares(row: Totals): { positive: number | null; negative: number | null } {
  const [one, two, , four, five] = ratingCounts(row);
  const counted = ratingCounts(row).reduce((sum, count) => sum + count, 0);
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
