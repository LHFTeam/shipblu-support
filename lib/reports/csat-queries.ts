import { and, desc, eq, isNotNull, sql, type Column, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { db } from '@/db/client';
import { agents, conversations, csatSurveys } from '@/db/schema';
import { describeSkip } from '@/lib/csat/skip-reasons';
import type { Range } from './category-queries';
import type { Totals } from './queries';
import { surveyedConversation } from './rollup';

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
 * Every one counts the conversations the rollup counts (`surveyedConversation`),
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
        surveyedConversation(),
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
        surveyedConversation(),
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
 * Yesterday once tonight's run has happened, the day before until then — the
 * cron is 00:00 UTC, two or three hours into the team's day, so the day
 * before yesterday has always had its run by the time anybody reads this.
 * Tonight's run is seen in the three days it rewrites: when every row among
 * them was written since the team's midnight (`rolledUpDays().recomputedAt`
 * is the oldest), the run happened, whether or not yesterday had anything
 * in it. The newest row was the first answer, and it is not one: an empty
 * day writes no row, so it named the last day anybody worked, and a quiet
 * week read as a rollup that had stopped. Nor is the newest write: a hand
 * run over one of the three days after midnight would pass for the whole
 * run. With three quiet days behind it there is nothing to see, and the page
 * stops a day early — a day with nothing in it — where stopping on a
 * yesterday the rollup has not reached would draw it as zeros and report
 * its sends as missing.
 *
 * A row for today, which only `rollup_metrics day=<today>` by hand can write,
 * is outside the three days and counts for nothing; a partial row for
 * yesterday written yesterday that way is older than the midnight it is
 * measured against.
 */
export function countedThrough(
  window: ReportWindow,
  rolledUp: { recomputedAt: Date | null },
): string {
  const today = DateTime.fromISO(window.to, { zone: window.zone });
  const ranTonight =
    rolledUp.recomputedAt !== null && rolledUp.recomputedAt >= today.startOf('day').toJSDate();
  return today.minus({ days: ranTonight ? 1 : 2 }).toISODate()!;
}

export type LiveDay = { day: string; sent: number; skipped: number };

/**
 * The surveys sent and the decisions against on each day of a window, counted
 * from `csat_surveys` — what the page checks the rollup against.
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
 * Two reads, each served by an index on its timestamp, grouped by position:
 * the zone is a parameter, and Postgres cannot see that the select's and a
 * `group by`'s are the same one.
 */
export async function liveSurveys(window: ReportWindow): Promise<LiveDay[]> {
  const dayOf = dayIn(window.zone);

  const sent = await db
    .select({ day: dayOf(csatSurveys.sentAt), count: sql<number>`count(*)::int` })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(within(csatSurveys.sentAt, window), surveyedConversation()))
    .groupBy(sql`1`);

  const skipped = await db
    .select({ day: dayOf(csatSurveys.createdAt), count: sql<number>`count(*)::int` })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(
      and(
        eq(csatSurveys.status, 'skipped'),
        within(csatSurveys.createdAt, window),
        surveyedConversation(),
      ),
    )
    .groupBy(sql`1`);

  const days = new Map<string, LiveDay>();
  for (const row of sent) days.set(row.day, { day: row.day, sent: row.count, skipped: 0 });
  for (const row of skipped) {
    const day = days.get(row.day);
    if (day) day.skipped = row.count;
    else days.set(row.day, { day: row.day, sent: 0, skipped: row.count });
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * The first day any survey was sent, in the team's zone — what the page says
 * when surveys began after a window opens.
 *
 * The first row in `sent_at` order rather than a `min()`: over a join,
 * Postgres reads every row for a `min()`, and this would be the one query on
 * the page that grew with the archive. No lower bound, for the reason
 * `rolledUpDays` gives.
 */
export async function firstSend(zone: string): Promise<string | null> {
  const [earliest] = await db
    .select({ first: dayIn(zone)(csatSurveys.sentAt) })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(isNotNull(csatSurveys.sentAt), surveyedConversation()))
    .orderBy(csatSurveys.sentAt)
    .limit(1);
  return earliest?.first ?? null;
}

/** The team's calendar day a timestamptz falls on, as the rollup keys it. */
function dayIn(zone: string) {
  return (column: Column) => sql<string>`(${column} at time zone ${zone})::date::text`;
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
