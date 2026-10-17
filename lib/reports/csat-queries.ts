import { and, desc, eq, isNotNull, sql, type Column, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { db } from '@/db/client';
import { agents, conversations, csatSurveys } from '@/db/schema';
import { describeSkip } from '@/lib/csat/skip-reasons';
import type { Range } from './category-queries';
import type { Totals } from './queries';
import { workedConversation } from './rollup';

/**
 * The satisfaction report's live reads: what the rollup cannot hold.
 *
 * Everything with a number in it on `/reports/csat` comes from `metrics_daily`
 * through `queries.ts`. These three read `csat_surveys` itself, each for a
 * reason a sum cannot serve — why tickets went unsurveyed, keyed on a reason
 * the rollup has no column for; the customers' own words; and the sends and
 * decisions against day by day, to check the rollup against. Each is a few
 * rows or an indexed count over the window, never an aggregate over the
 * archive.
 *
 * Every one counts the conversations the rollup counts (`workedConversation`),
 * and keys a survey on the timestamp the rollup does for the same fact, so the
 * live sections and the figures above them describe one set of surveys.
 */

export type ReportWindow = Range & { zone: string };

/**
 * A timestamptz falls on one of the window's days, in the team's zone — the
 * `rangeIn()` rule, never the database's `current_date`, which is UTC's
 * (`docs/PROJECT-STATE.md` §6.52).
 */
function within(column: Column, window: ReportWindow): SQL {
  return sql`${column} >= (${window.from}::date)::timestamp at time zone ${window.zone}
    and ${column} < ((${window.to}::date + 1))::timestamp at time zone ${window.zone}`;
}

export type SkipCount = { reason: string; label: string; count: number };

/**
 * Why tickets resolved in the window got no survey, most common first — the
 * table that tunes the delay and shows a channel switched off.
 *
 * It holds every reason a row was written for, and only those: a ticket on a
 * channel nobody surveys, or resolved while surveys or its channel were off,
 * is turned away before a row is written (`scheduleSurvey`), so those count in
 * neither this table nor the surveys sent. The page says so beside it.
 */
export async function skipReasons(window: ReportWindow): Promise<SkipCount[]> {
  const rows = await db
    .select({
      reason: sql<string>`coalesce(${csatSurveys.skipReason}, '')`,
      count: sql<number>`count(*)::int`,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(
      and(
        eq(csatSurveys.status, 'skipped'),
        within(csatSurveys.createdAt, window),
        workedConversation(),
      ),
    )
    .groupBy(csatSurveys.skipReason)
    .orderBy(sql`count(*) desc`, csatSurveys.skipReason);

  return rows.map((row) => ({ ...row, label: describeSkip(row.reason) }));
}

export type SurveyComment = {
  id: string;
  respondedAt: Date;
  rating: number;
  comment: string;
  channel: string;
  /** Who the survey was about, or null when nobody was assigned. */
  agent: string | null;
  /** The ticket's number, for the link to it. */
  number: number;
};

/** How many comments the report lists: the newest, which are what a supervisor opens. */
export const COMMENT_LIMIT = 50;

/**
 * The newest answers in the window that came with words, rating and all.
 *
 * Keyed on `responded_at`, the timestamp the rollup files an answer under, so a
 * comment is listed in the window whose figures its rating is part of. A
 * comment added later to an answer already made (`recordAnswer`) carries the
 * answer's instant, which is the one it belongs with.
 */
export async function latestComments(window: ReportWindow): Promise<SurveyComment[]> {
  const rows = await db
    .select({
      id: csatSurveys.id,
      respondedAt: csatSurveys.respondedAt,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      // The survey's own channel, as the rollup counts it (`computeDay`).
      channel: sql<string>`coalesce(${csatSurveys.channel}, ${conversations.channel})`,
      agent: sql<string | null>`coalesce(${agents.name}, ${agents.email})`,
      number: conversations.number,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .leftJoin(agents, eq(agents.id, csatSurveys.agentId))
    .where(
      and(
        isNotNull(csatSurveys.rating),
        isNotNull(csatSurveys.respondedAt),
        // `recordAnswer`, the one door, trims a comment and stores a blank one
        // as null — so null is the whole test, and no `btrim` here to disagree
        // with it (Postgres's strips only the space; §6.97).
        isNotNull(csatSurveys.comment),
        within(csatSurveys.respondedAt, window),
        workedConversation(),
      ),
    )
    .orderBy(desc(csatSurveys.respondedAt), desc(csatSurveys.id))
    .limit(COMMENT_LIMIT);

  return rows.map((row) => ({
    ...row,
    respondedAt: row.respondedAt!,
    rating: row.rating!,
    comment: row.comment!,
  }));
}

/**
 * The last day the page can count on the rollup having computed, and so the
 * end of every figure on it and of every live read checked against them.
 *
 * Yesterday once tonight's run has written it, the day before until then —
 * the cron is 00:00 UTC, two or three hours into the team's day, so the day
 * before yesterday has always had its run by the time anybody reads this.
 * Whether tonight's has happened is read off the rollup's newest row, which is
 * the one way to tell from here, and it answers "not yet" for a yesterday
 * nobody worked: `computeDay` writes nothing for an empty day. That is the
 * safe way to be wrong. Stopping a day early on a quiet day leaves out a day
 * with nothing in it, where stopping on a yesterday the rollup has not reached
 * would draw it as a day of zeros and report its sends as missing — and the
 * newest row alone, the first version, named the last day anybody *worked*
 * as the last day rolled up, so a quiet week read as a rollup that stopped.
 *
 * A row for today, which only `rollup_metrics day=<today>` by hand can write,
 * is a partial day and counts as nothing beyond yesterday.
 */
export function countedThrough(range: Range, newestRow: string | null): string {
  const today = DateTime.fromISO(range.to, { zone: 'utc' });
  const yesterday = today.minus({ days: 1 }).toISODate()!;
  return newestRow !== null && newestRow >= yesterday
    ? yesterday
    : today.minus({ days: 2 }).toISODate()!;
}

export type LiveDay = { day: string; sent: number; skipped: number };

/**
 * The surveys sent and the decisions against on each day of a window, counted
 * from `csat_surveys`, and the first day any survey was sent at all — what the
 * page checks the rollup against.
 *
 * The rollup can be short of the surveys for two reasons that look the same
 * from its side: a night the job did not run, and a day rolled up before
 * survey counts were kept, whose columns read 0 until it is computed again.
 * Counting the same surveys live, on the same days and the same timestamps,
 * is the one way the page can tell "none were sent" from "none were counted"
 * and say which. Per day, not one total for the window: a day where the
 * rollup still counts a survey since purged (`lib/admin/purge-summary.ts`)
 * would otherwise cancel a day it is missing one.
 *
 * Three reads, each served by an index on its timestamp. The first send is
 * the first row in `sent_at` order rather than a `min()` — over a join,
 * Postgres reads every row for a `min()`, and this would be the one query on
 * the page that grew with the archive. `first` has no lower bound, for the
 * reason `rolledUpDays` gives. Grouped by position, because the zone is a
 * parameter and Postgres cannot see that the select's and a `group by`'s are
 * the same one.
 */
export async function liveSurveys(
  window: ReportWindow,
): Promise<{ days: LiveDay[]; first: string | null }> {
  const dayOf = (column: Column) =>
    sql<string>`(${column} at time zone ${window.zone})::date::text`;

  const sent = await db
    .select({ day: dayOf(csatSurveys.sentAt), count: sql<number>`count(*)::int` })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(within(csatSurveys.sentAt, window), workedConversation()))
    .groupBy(sql`1`);

  const skipped = await db
    .select({ day: dayOf(csatSurveys.createdAt), count: sql<number>`count(*)::int` })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(
      and(
        eq(csatSurveys.status, 'skipped'),
        within(csatSurveys.createdAt, window),
        workedConversation(),
      ),
    )
    .groupBy(sql`1`);

  const [earliest] = await db
    .select({ first: dayOf(csatSurveys.sentAt) })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(isNotNull(csatSurveys.sentAt), workedConversation()))
    .orderBy(csatSurveys.sentAt)
    .limit(1);

  const days = new Map<string, LiveDay>();
  for (const row of sent) days.set(row.day, { day: row.day, sent: row.count, skipped: 0 });
  for (const row of skipped) {
    const day = days.get(row.day);
    if (day) day.skipped = row.count;
    else days.set(row.day, { day: row.day, sent: 0, skipped: row.count });
  }

  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    first: earliest?.first ?? null,
  };
}

/**
 * What the live counts hold that the rollup does not: the sends and the
 * decisions against on each day beyond what that day's row counts, and the
 * days they fall on. A day the rollup counts more on — a survey since purged
 * — is not a shortfall, and is not set against one.
 */
export function uncounted(
  live: LiveDay[],
  rolled: (Pick<Totals, 'csatSentCount' | 'csatSkippedCount'> & { day: string })[],
): { sent: number; skipped: number; days: LiveDay[] } {
  const byDay = new Map(rolled.map((row) => [row.day, row]));
  const days = live
    .map((day) => ({
      day: day.day,
      sent: Math.max(0, day.sent - (byDay.get(day.day)?.csatSentCount ?? 0)),
      skipped: Math.max(0, day.skipped - (byDay.get(day.day)?.csatSkippedCount ?? 0)),
    }))
    .filter((day) => day.sent > 0 || day.skipped > 0);
  return {
    sent: days.reduce((sum, day) => sum + day.sent, 0),
    skipped: days.reduce((sum, day) => sum + day.skipped, 0),
    days,
  };
}
