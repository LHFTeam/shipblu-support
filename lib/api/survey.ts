import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client';
import { conversations, csatSurveys } from '@/db/schema';
import { recordAnswer } from '@/lib/csat';
import { MAX_COMMENT } from '@/lib/csat/limits';
import { wordingForRule } from '@/lib/csat/rules';
import { ratingLabels } from '@/lib/csat/wording';
import type { Survey } from './schemas';
import { ownedTicket } from './scope';
import type { Caller } from './sessions';

/**
 * The myBlu app's satisfaction survey (`plans/myblu-ticket-api.md`, stage 8;
 * `plans/csat.md`, _myBlu_): the survey `send_csat` wrote for an `api` ticket
 * as `api_pull`, read and answered by the app, which draws it itself.
 *
 * **A ticket's survey is its newest that is not `skipped`.** A skipped row is a
 * survey the team decided not to send, which to the app is no survey: a ticket
 * resolved, reopened and resolved again inside the resurvey window keeps its
 * first survey and gains a `skipped` row, and the survey it has is the first.
 * A survey a newer one superseded is `expired`, and older than the newer one,
 * so the app sees the newer. `surveyOrder` and `notSkipped` are that rule, read
 * by the survey routes and by every ticket's `survey` summary
 * (`surveyStatusSql`), so a list cannot prompt for a survey the route does not
 * serve.
 *
 * **Every statement names the caller**, through `ownedTicket` on the survey's
 * ticket in the same `WHERE`, as every other read of the API does: another
 * user's ticket, one deleted, spam or merged away, and one on another channel
 * are one `404` with a ticket that has no survey.
 */

/** Newest first: by when it was sent, then when the row was written, then its id. */
const surveyOrder: SQL = sql`${csatSurveys.sentAt} desc nulls last, ${csatSurveys.createdAt} desc, ${csatSurveys.id} desc`;

const notSkipped: SQL = ne(csatSurveys.status, 'skipped');

/**
 * The status of a ticket's survey as the app sees it, or null, as one column of
 * a statement that reads `conversations` beside another table: the ticket's
 * `survey` summary (`ticketColumns` in `lib/api/tickets.ts`). Only from such a
 * statement, because drizzle writes a one-table select's fields unqualified,
 * and `conversation_id = id` would then compare the survey with itself
 * (AGENTS.md, _Tests_); both readers join the ownership row.
 */
export const surveyStatusSql = sql<'sent' | 'answered' | 'expired' | null>`(
  select ${csatSurveys.status} from ${csatSurveys}
  where ${csatSurveys.conversationId} = ${conversations.id} and ${notSkipped}
  order by ${surveyOrder}
  limit 1
)`;

type SurveyView = z.input<typeof Survey>;

type SurveyRow = {
  id: string;
  status: 'sent' | 'answered' | 'skipped' | 'expired';
  rating: number | null;
  comment: string | null;
  locale: string | null;
  ruleId: string | null;
};

/** The survey the app sees on one of the caller's tickets, or null. */
async function currentSurvey(caller: Caller, ticketId: string): Promise<SurveyRow | null> {
  const [row] = await db
    .select({
      id: csatSurveys.id,
      status: csatSurveys.status,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      locale: csatSurveys.locale,
      ruleId: csatSurveys.ruleId,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(eq(conversations.id, ticketId), ownedTicket(caller), notSkipped))
    .orderBy(surveyOrder)
    .limit(1);
  return row ?? null;
}

/**
 * A survey, worded on the server in its own locale, which can differ from the
 * app's: the rule it went out with, or the built-in wording a rule deleted
 * since was a variation of, as the survey page and the widget's card word it.
 * A survey with no locale on record is Arabic, the front door, as the card's
 * is. `expiresAt` is null: nothing lapses a survey but a newer one, which
 * makes it `expired`.
 */
async function surveyView(row: SurveyRow): Promise<SurveyView> {
  const locale = row.locale === 'en' ? 'en' : 'ar';
  const wording = await wordingForRule(row.ruleId, locale);
  return {
    id: row.id,
    // Never `skipped`: `currentSurvey` leaves those out.
    status: row.status === 'skipped' ? 'expired' : row.status,
    rating: row.rating,
    comment: row.comment,
    locale,
    intro: wording.intro,
    question: wording.question,
    labels: ratingLabels(locale),
    commentPrompt: wording.commentPrompt,
    commentMaxChars: MAX_COMMENT,
    button: wording.button,
    thanks: wording.thanks,
    expiresAt: null,
  };
}

/** `GET /tickets/{id}/survey`: the ticket's survey, or null for every reason it has none. */
export async function readSurvey(caller: Caller, ticketId: string): Promise<SurveyView | null> {
  const row = await currentSurvey(caller, ticketId);
  return row ? surveyView(row) : null;
}

/**
 * `POST /tickets/{id}/survey`: an answer, through the one door every answer
 * goes through (`recordAnswer(…, 'api')`), and the survey as it stands
 * afterwards, or null for a ticket with no survey of the caller's.
 *
 * `recordAnswer`'s rules are kept, not restated: the first rating wins
 * whichever door it came through, a later comment attaches to an answered
 * survey whose comment is empty, and anything else is ignored. So the app draws
 * what this answers, never the rating tapped. One survey it does not take: an
 * `expired` one, which the widget's card refuses for the same reason
 * (`answerSurvey` in `lib/widget/conversation.ts`) — a survey a newer one
 * superseded, drawn closed, where `recordAnswer` alone would still take a
 * rating for it, as an old link always did. It is answered as it stands.
 */
export async function answerSurvey(
  caller: Caller,
  ticketId: string,
  rating: number,
  comment: string | null,
): Promise<SurveyView | null> {
  const row = await currentSurvey(caller, ticketId);
  if (!row) return null;
  if (row.status === 'sent' || row.status === 'answered') {
    await recordAnswer(row.id, rating, comment, 'api');
  }
  return readSurvey(caller, ticketId);
}
