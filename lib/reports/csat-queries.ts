import { and, desc, eq, isNotNull, sql, type Column, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversations, csatSurveys } from '@/db/schema';
import { describeSkip } from '@/lib/csat/skip-reasons';
import type { Range } from './category-queries';
import { workedConversation } from './rollup';

/**
 * The satisfaction report's live reads: what the rollup cannot hold.
 *
 * Everything with a number in it on `/reports/csat` comes from `metrics_daily`
 * through `queries.ts`. These three read `csat_surveys` itself, each for a
 * reason a sum cannot serve — why tickets went unsurveyed, keyed on a reason
 * the rollup has no column for; the customers' own words; and a count of the
 * surveys sent, to check the rollup against. Each is a few rows or an indexed
 * count over the window, never an aggregate over the archive.
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
        sql`btrim(${csatSurveys.comment}) <> ''`,
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
 * The surveys sent in a window, counted from `csat_surveys`, and the first day
 * any survey was sent at all — what the page checks the rollup against.
 *
 * The rollup can be short of the surveys for two reasons that look the same
 * from its side: a night the job did not run, and a day rolled up before
 * survey counts were kept, whose columns read 0 until it is computed again.
 * Counting the same surveys live, on the same days, is the one way the page
 * can tell "none were sent" from "none were counted" and say which. `first`
 * has no lower bound, for the reason `rolledUpDays` gives.
 */
export async function sentSurveys(
  window: ReportWindow,
): Promise<{ sent: number; first: string | null }> {
  const [row] = await db
    .select({
      sent: sql<number>`(count(*) filter (where ${within(csatSurveys.sentAt, window)}))::int`,
      first: sql<
        string | null
      >`(min(${csatSurveys.sentAt}) at time zone ${window.zone})::date::text`,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(isNotNull(csatSurveys.sentAt), workedConversation()));

  return { sent: row?.sent ?? 0, first: row?.first ?? null };
}
