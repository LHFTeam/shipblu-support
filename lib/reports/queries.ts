import { and, between, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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
 * Where the window's figures start, and on how many days there are any.
 *
 * The rollup recomputes three days a night and has no backfill, so a window
 * wider than the history returns the same rows as a narrower one and the range
 * control looks broken. The page compares `first` with the window's start to
 * say so. Read from the totals slice, the one every figure on the page sums.
 */
export async function rolledUpDays(range: Range): Promise<{ first: string | null; days: number }> {
  const [row] = await db
    .select({
      first: sql<string | null>`min(${metricsDaily.day})::text`,
      days: sql<number>`count(distinct ${metricsDaily.day})::int`,
    })
    .from(metricsDaily)
    .where(
      and(
        inRange(range),
        isNull(metricsDaily.groupId),
        isNull(metricsDaily.agentId),
        isNull(metricsDaily.channel),
      ),
    );

  return { first: row?.first ?? null, days: row?.days ?? 0 };
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
