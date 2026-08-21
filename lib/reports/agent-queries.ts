import { DateTime } from 'luxon';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentMetricsDaily, agents, metricsDaily } from '@/db/schema';

/**
 * Read models for the agent productivity report.
 *
 * Two tables, joined rather than merged. `agent_metrics_daily` holds the half
 * that is about the person — when they were here, how long, what they were
 * holding — and `metrics_daily`'s per-agent slice holds the half that is about
 * the tickets, which it has computed since reporting first shipped.
 *
 * Joining instead of copying is the point. Storing "resolved" in both places
 * would be two numbers that agree until one of the two rollups changes, and the
 * one that then disagrees silently is the one somebody's appraisal is based on.
 *
 * Like the sibling read models in `queries.ts`, everything here reads rolled-up
 * rows only. Opening this page must never put an aggregate over the presence or
 * message history in front of the database.
 */

/** The per-agent totals slice: group and channel both null, agent set. */
const AGENT_SLICE = and(isNull(metricsDaily.groupId), isNull(metricsDaily.channel));

const SUMS = {
  onlineSeconds: sql<number>`coalesce(sum(${agentMetricsDaily.onlineSeconds}), 0)::bigint`,
  acceptingSeconds: sql<number>`coalesce(sum(${agentMetricsDaily.acceptingSeconds}), 0)::bigint`,
  onlineWithinHoursSeconds: sql<number>`coalesce(sum(${agentMetricsDaily.onlineWithinHoursSeconds}), 0)::bigint`,
  scheduledSeconds: sql<number>`coalesce(sum(${agentMetricsDaily.scheduledSeconds}), 0)::bigint`,
  focusSeconds: sql<number>`coalesce(sum(${agentMetricsDaily.focusSeconds}), 0)::bigint`,
  conversationsFocused: sql<number>`coalesce(sum(${agentMetricsDaily.conversationsFocused}), 0)::int`,
  sessionCount: sql<number>`coalesce(sum(${agentMetricsDaily.sessionCount}), 0)::int`,
  assignedCount: sql<number>`coalesce(sum(${agentMetricsDaily.assignedCount}), 0)::int`,
  touchedCount: sql<number>`coalesce(sum(${agentMetricsDaily.touchedCount}), 0)::int`,
  publicReplies: sql<number>`coalesce(sum(${agentMetricsDaily.publicReplies}), 0)::int`,
  privateNotes: sql<number>`coalesce(sum(${agentMetricsDaily.privateNotes}), 0)::int`,
  transferredAwayCount: sql<number>`coalesce(sum(${agentMetricsDaily.transferredAwayCount}), 0)::int`,
  reclaimedFromCount: sql<number>`coalesce(sum(${agentMetricsDaily.reclaimedFromCount}), 0)::int`,
  reopenedAfterResolveCount: sql<number>`coalesce(sum(${agentMetricsDaily.reopenedAfterResolveCount}), 0)::int`,
  daysWorked: sql<number>`count(*) filter (where ${agentMetricsDaily.onlineSeconds} > 0)::int`,

  // From the ticket rollup. Left joined, so an agent who was online and closed
  // nothing still gets a row rather than vanishing from the report.
  ticketsResolved: sql<number>`coalesce(sum(${metricsDaily.ticketsResolved}), 0)::int`,
  ticketsCreated: sql<number>`coalesce(sum(${metricsDaily.ticketsCreated}), 0)::int`,
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

type Sums = { [K in keyof typeof SUMS]: number };

export type AgentSummary = Sums & { agentId: string; name: string };

export type AgentDayRow = Sums & {
  day: string;
  firstOnlineAt: Date | null;
  lastOnlineAt: Date | null;
  scheduledStartAt: Date | null;
  scheduledEndAt: Date | null;
  longestSessionSeconds: number;
  openAtDayEnd: number | null;
  pendingAtDayEnd: number | null;
};

/**
 * The window a range covers, as the `YYYY-MM-DD` the rollup writes.
 *
 * In the reporting zone rather than UTC, because the rollup buckets days in the
 * team's zone: asking for "the last 7 days" in UTC selects a window whose edges
 * are two or three hours out, which silently includes or drops an evening shift
 * at each end.
 */
export function rangeIn(zone: string, days: number): { from: string; to: string } {
  const today = DateTime.now().setZone(zone).startOf('day');

  return {
    from: today.minus({ days: days - 1 }).toISODate()!,
    to: today.toISODate()!,
  };
}

/** One row per agent for the whole range, busiest first. */
export async function agentSummaries(zone: string, days: number): Promise<AgentSummary[]> {
  const { from, to } = rangeIn(zone, days);

  const rows = await db
    .select({
      agentId: agents.id,
      name: sql<string>`coalesce(nullif(${agents.name}, ''), ${agents.email})`,
      ...SUMS,
    })
    .from(agentMetricsDaily)
    .innerJoin(agents, eq(agents.id, agentMetricsDaily.agentId))
    .leftJoin(
      metricsDaily,
      and(
        eq(metricsDaily.day, agentMetricsDaily.day),
        eq(metricsDaily.agentId, agentMetricsDaily.agentId),
        AGENT_SLICE,
      ),
    )
    .where(and(gte(agentMetricsDaily.day, from), lte(agentMetricsDaily.day, to)))
    .groupBy(agents.id)
    .orderBy(desc(sql`sum(${agentMetricsDaily.onlineSeconds})`), asc(agents.name));

  return rows.map((row) => ({ ...normalise(row), agentId: row.agentId, name: row.name }));
}

/** One row per day for a single agent, oldest first. */
export async function agentDays(
  zone: string,
  days: number,
  agentId: string,
): Promise<AgentDayRow[]> {
  const { from, to } = rangeIn(zone, days);

  const rows = await db
    .select({
      day: agentMetricsDaily.day,
      firstOnlineAt: agentMetricsDaily.firstOnlineAt,
      lastOnlineAt: agentMetricsDaily.lastOnlineAt,
      scheduledStartAt: agentMetricsDaily.scheduledStartAt,
      scheduledEndAt: agentMetricsDaily.scheduledEndAt,
      longestSessionSeconds: agentMetricsDaily.longestSessionSeconds,
      openAtDayEnd: agentMetricsDaily.openAtDayEnd,
      pendingAtDayEnd: agentMetricsDaily.pendingAtDayEnd,
      ...SUMS,
    })
    .from(agentMetricsDaily)
    .leftJoin(
      metricsDaily,
      and(
        eq(metricsDaily.day, agentMetricsDaily.day),
        eq(metricsDaily.agentId, agentMetricsDaily.agentId),
        AGENT_SLICE,
      ),
    )
    .where(
      and(
        eq(agentMetricsDaily.agentId, agentId),
        gte(agentMetricsDaily.day, from),
        lte(agentMetricsDaily.day, to),
      ),
    )
    .groupBy(agentMetricsDaily.id)
    .orderBy(asc(agentMetricsDaily.day));

  return rows.map((row) => ({
    ...normalise(row),
    day: row.day,
    firstOnlineAt: row.firstOnlineAt,
    lastOnlineAt: row.lastOnlineAt,
    scheduledStartAt: row.scheduledStartAt,
    scheduledEndAt: row.scheduledEndAt,
    longestSessionSeconds: row.longestSessionSeconds,
    openAtDayEnd: row.openAtDayEnd,
    pendingAtDayEnd: row.pendingAtDayEnd,
  }));
}

/**
 * `bigint` sums arrive from postgres.js as strings, because a bigint does not
 * always fit a JavaScript number. These are seconds, so they always do — but
 * without the conversion every average silently becomes NaN, which is the same
 * trap `queries.ts` documents.
 */
function normalise(row: Partial<Record<keyof Sums, unknown>>): Sums {
  const value = (key: keyof Sums) => Number(row[key] ?? 0) || 0;

  return Object.fromEntries(
    (Object.keys(SUMS) as (keyof Sums)[]).map((key) => [key, value(key)]),
  ) as Sums;
}

// --- Derived figures --------------------------------------------------------
// Functions over a row rather than stored columns, so each ratio is defined once
// and a slice with no data reads as "—" everywhere instead of as a confident 0%.

/**
 * Share of time at the desk that was spent on a ticket.
 *
 * The market's healthy band is 75–85%. Sustained above that correlates with
 * rising handle times, falling CSAT and attrition — so this is a metric with a
 * ceiling as well as a floor, and the meter renders it that way rather than
 * treating "higher is better".
 */
export function occupancy(row: { focusSeconds: number; onlineSeconds: number }): number | null {
  return row.onlineSeconds > 0 ? Math.round((row.focusSeconds / row.onlineSeconds) * 100) : null;
}

/** Share of the scheduled shift actually covered. Above 85% is the usual target. */
export function adherence(row: {
  onlineWithinHoursSeconds: number;
  scheduledSeconds: number;
}): number | null {
  return row.scheduledSeconds > 0
    ? Math.round((row.onlineWithinHoursSeconds / row.scheduledSeconds) * 100)
    : null;
}

/**
 * Minutes after the shift opened that the agent first appeared. Negative is
 * early.
 *
 * Null when either end is missing, which covers the two cases that must never
 * read as lateness: a day the schedule was closed, and a day the agent never
 * came online at all — absence is a different fact from being late, and
 * flattening them would hide both.
 */
export function minutesLate(row: {
  firstOnlineAt: Date | null;
  scheduledStartAt: Date | null;
}): number | null {
  if (!row.firstOnlineAt || !row.scheduledStartAt) return null;
  return Math.round((row.firstOnlineAt.getTime() - row.scheduledStartAt.getTime()) / 60_000);
}

/** Minutes before the shift closed that the agent was last seen. Negative is late. */
export function minutesEarlyOff(row: {
  lastOnlineAt: Date | null;
  scheduledEndAt: Date | null;
}): number | null {
  if (!row.lastOnlineAt || !row.scheduledEndAt) return null;
  return Math.round((row.scheduledEndAt.getTime() - row.lastOnlineAt.getTime()) / 60_000);
}

/** Measured handling time per conversation worked. */
export function handlingSeconds(row: {
  focusSeconds: number;
  conversationsFocused: number;
}): number | null {
  return row.conversationsFocused > 0
    ? Math.round(row.focusSeconds / row.conversationsFocused)
    : null;
}

/**
 * Share of this agent's resolutions that somebody had to reopen.
 *
 * The counterweight to every speed column on the page. Handling time and
 * resolution time both improve when tickets are closed before they are
 * finished, and this is the number that shows it — which is why it sits beside
 * them rather than in a section of its own.
 */
export function reopenRate(row: {
  reopenedAfterResolveCount: number;
  ticketsResolved: number;
}): number | null {
  return row.ticketsResolved > 0
    ? Math.round((row.reopenedAfterResolveCount / row.ticketsResolved) * 100)
    : null;
}

/** Throughput against time actually at the desk, not against the calendar. */
export function resolvedPerHour(row: {
  ticketsResolved: number;
  onlineSeconds: number;
}): number | null {
  if (row.onlineSeconds < 600) return null;
  return Math.round((row.ticketsResolved / (row.onlineSeconds / 3600)) * 10) / 10;
}

/**
 * Whether the focus beat reported anything for a day with work on it.
 *
 * The beat runs in the agent's browser and can be blocked, so a zero here is
 * ambiguous in a way none of the other figures are: it means either "did not
 * work a ticket" or "we could not see". Callers show handling time as "—"
 * rather than "0s" in that case, because an unmeasured agent must never render
 * as an idle one.
 */
export function focusMeasured(row: { focusSeconds: number; touchedCount: number }): boolean {
  return row.focusSeconds > 0 || row.touchedCount === 0;
}

/** "8h 20m", "45m", "—" — hours read better than the seconds formatter here. */
export function formatHours(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '—';

  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) return `${rest}m`;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** A wall-clock time in the team's zone, which is the only zone a shift means. */
export function formatClock(at: Date | null, zone: string): string {
  return at ? DateTime.fromJSDate(at, { zone }).toFormat('HH:mm') : '—';
}

/** "+12m late", "8m early", "—". */
export function formatDrift(minutes: number | null, lateWord = 'late'): string {
  if (minutes === null) return '—';
  if (minutes === 0) return 'on time';
  return minutes > 0 ? `${minutes}m ${lateWord}` : `${Math.abs(minutes)}m early`;
}
