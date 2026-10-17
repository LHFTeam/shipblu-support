import { and, between, desc, eq, isNotNull, sql, type Column } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { db } from '@/db/client';
import { agents, conversations, csatSurveys } from '@/db/schema';
import { describeSkip } from '@/lib/csat/skip-reasons';
import type { Totals } from './queries';
import { surveyedConversation, within, type ReportWindow } from './rollup';

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
  /**
   * Who the survey was about, or null when nobody was assigned — and always
   * null for a viewer without `report.agents`, for whom it is never read.
   */
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
 * comment is listed on the day its rating is counted — once that day is
 * rolled up; the list runs to now, past the figures. A comment added later to
 * an answer already made (`recordAnswer`) carries the answer's instant, which
 * is the one it belongs with.
 *
 * The agent is joined only for a viewer who may see who handled a ticket
 * (`report.agents`): without it the name is never read, so no later change
 * to the page can draw it.
 */
export async function latestComments(
  window: ReportWindow,
  namesAgents: boolean,
): Promise<SurveyComment[]> {
  const query = db
    .select({
      id: csatSurveys.id,
      respondedAt: csatSurveys.respondedAt,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      // The survey's own channel, as the rollup counts it (`computeDay`).
      channel: sql<string>`coalesce(${csatSurveys.channel}, ${conversations.channel})`,
      agent: namesAgents
        ? sql<string | null>`coalesce(${agents.name}, ${agents.email})`
        : sql<string | null>`null`,
      number: conversations.number,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .$dynamic();

  const rows = await (
    namesAgents ? query.leftJoin(agents, eq(agents.id, csatSurveys.agentId)) : query
  )
    .where(
      and(
        // A rating as the rollup defines one, 1 to 5: the list shows each
        // beside its comment, and the scale has no step for one off it.
        between(csatSurveys.rating, 1, 5),
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
 * end of every figure on it and of every live read checked against them: the
 * newest day it has computed whole (`lastWholeDay`).
 *
 * That is yesterday once tonight's run has reached it — the cron is 00:00
 * UTC, two or three hours into the team's day — the day before until then,
 * and further back after a night the run did not happen, rather than a day
 * it has not computed drawn as zeros. `rollup_days` holds a day the rollup
 * computed whether or not it had anything in it, so a quiet yesterday counts
 * once the run has reached it, and a hand run over another day cannot pass
 * for it. A day computed by hand while it was still going is not whole, nor
 * is one whose reads began before its midnight and committed after it.
 *
 * Until a run of this version has written the table there is no such day,
 * and the page falls back to the day before yesterday, which the nightly run
 * reaches on the night after it ends: a day short, until the next run.
 */
export function countedThrough(window: ReportWindow, lastWhole: string | null): string {
  return (
    lastWhole ?? DateTime.fromISO(window.to, { zone: window.zone }).minus({ days: 2 }).toISODate()!
  );
}

/**
 * The days between the last one the figures count and today, neither
 * included: 0 once tonight's run has reached yesterday, 1 before it, and
 * more only when the rollup has fallen behind — the page says so then, since
 * the end it prints is otherwise the only sign.
 */
export function daysUncounted(window: ReportWindow, through: string): number {
  const today = DateTime.fromISO(window.to, { zone: 'utc' });
  return Math.max(
    0,
    Math.round(today.diff(DateTime.fromISO(through, { zone: 'utc' }), 'days').days) - 1,
  );
}

export type LiveDay = { day: string; sent: number; skipped: number };

/**
 * The surveys sent and the decisions against on each day of a window, counted
 * from `csat_surveys` — what the page checks the rollup against.
 *
 * The rollup can be short of the surveys for reasons that look the same from
 * its side: a day rolled up before survey counts were kept, whose columns
 * read 0 until it is computed again, and a day no run computed whole,
 * behind a later one that was. One drift it cannot tell from those: after
 * the team's time zone changes, a day rolled up in the old zone holds a
 * send the new zone files on the day beside it, which reads as missing
 * there though the totals hold it.
 * Counting the same surveys live, on the same days and the same timestamps,
 * is the one way the page can tell "none were sent" from "none were counted"
 * and say which. Per day, not one total for the window: a day where the
 * rollup still counts a survey since purged (`lib/admin/purge-summary.ts`)
 * would otherwise cancel a day it is missing one.
 *
 * One statement, two reads joined by `union all`, each served by the index on
 * its own timestamp — a send is a fact of its `sent_at`, a decision against
 * of its `created_at`, so the two cannot be one scan keyed on either — and
 * grouped outside them, where the zone is no longer a parameter.
 */
export async function liveSurveys(window: ReportWindow): Promise<LiveDay[]> {
  const dayOf = dayIn(window.zone);

  const rows = await db.execute<LiveDay>(sql`
    select day,
           count(*) filter (where fact = 'sent')::int as sent,
           count(*) filter (where fact = 'skipped')::int as skipped
    from (
      select ${dayOf(csatSurveys.sentAt)} as day, 'sent' as fact
      from ${csatSurveys}
      join ${conversations} on ${conversations.id} = ${csatSurveys.conversationId}
      where ${within(csatSurveys.sentAt, window)} and ${surveyedConversation()}
      union all
      select ${dayOf(csatSurveys.createdAt)}, 'skipped'
      from ${csatSurveys}
      join ${conversations} on ${conversations.id} = ${csatSurveys.conversationId}
      where ${eq(csatSurveys.status, 'skipped')}
        and ${within(csatSurveys.createdAt, window)}
        and ${surveyedConversation()}
    ) facts
    group by day
    order by day
  `);

  return rows.map((row) => ({ day: row.day, sent: row.sent, skipped: row.skipped }));
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
