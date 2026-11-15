import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client';
import { conversations, csatSurveys } from '@/db/schema';
import { recordAnswer } from '@/lib/csat';
import { PULLED } from '@/lib/csat/delivery';
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
 * **A ticket's survey is its newest the app pulls (`api_pull`) that is not
 * `skipped`.** One rule for the route, every ticket's `survey` summary, the
 * list's `lastActivityAt` and the webhook (`decideSurveyCreated`, which refuses
 * any other delivery): an `api` ticket surveyed another way — by an email link
 * or a widget card, which only a ticket surveyed before the app's survey
 * shipped could be — is no survey to the app, rather than one the route serves
 * and the push refuses. A skipped row is a
 * survey the team decided not to send, which to the app is no survey: a ticket
 * resolved, reopened and resolved again inside the resurvey window keeps its
 * first survey and gains a `skipped` row, and the survey it has is the first.
 * A survey a newer one superseded is `expired`, and older than the newer one,
 * so the app sees the newer. `surveyOrder` and `appSurvey` are that rule, read
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

/** The surveys the app sees: pulled, and not a decision not to send one. */
const appSurvey: SQL = and(eq(csatSurveys.delivery, PULLED), ne(csatSurveys.status, 'skipped'))!;

/**
 * The status of a ticket's survey as the app sees it, or null, as one column of
 * a statement that reads `conversations` beside another table: the ticket's
 * `survey` summary (`ticketColumns` in `lib/api/tickets.ts`). Only from such a
 * statement, because drizzle writes a one-table select's fields unqualified,
 * and `conversation_id = id` would then compare the survey with itself
 * (AGENTS.md, _Tests_); both readers join the ownership row.
 */
export const surveyStatusSql = sql<AppSurveyStatus | null>`(
  select ${csatSurveys.status} from ${csatSurveys}
  where ${csatSurveys.conversationId} = ${conversations.id} and ${appSurvey}
  order by ${surveyOrder}
  limit 1
)`;

/**
 * When the app was last given a survey on the ticket, or null: the newest
 * `sent_at` of the surveys it sees, as one column of a statement that reads
 * `conversations` beside another table, for the reason `surveyStatusSql`
 * gives. The list's `lastActivityAt` is the later of this and the newest
 * message (`lib/api/tickets.ts`), so a ticket whose survey is written moves to
 * the top of the list a poll re-reads, where the summary that prompts for it
 * is.
 */
export const surveyGivenAtSql = sql<string | null>`(
  select max(${csatSurveys.sentAt}) from ${csatSurveys}
  where ${csatSurveys.conversationId} = ${conversations.id} and ${appSurvey}
)`;

type SurveyView = z.input<typeof Survey>;

/** What a survey the app sees can be: never `skipped`, which `appSurvey` leaves out. */
type AppSurveyStatus = 'sent' | 'answered' | 'expired';

type SurveyRow = {
  id: string;
  status: AppSurveyStatus;
  rating: number | null;
  comment: string | null;
  locale: string | null;
  ruleId: string | null;
};

/**
 * The status read where `appSurvey` is in the `WHERE`: the column, typed to
 * what that filter lets through, so no reader maps a `skipped` it cannot meet.
 */
const appSurveyStatus = sql<AppSurveyStatus>`${csatSurveys.status}`;

/** The survey the app sees on one of the caller's tickets, or null. */
async function currentSurvey(caller: Caller, ticketId: string): Promise<SurveyRow | null> {
  const [row] = await db
    .select({
      id: csatSurveys.id,
      status: appSurveyStatus,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      locale: csatSurveys.locale,
      ruleId: csatSurveys.ruleId,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(and(eq(conversations.id, ticketId), ownedTicket(caller), appSurvey))
    .orderBy(surveyOrder)
    .limit(1);
  return row ?? null;
}

/** One survey's answer as it stands, by its id, for the answer to a POST. */
async function answerOf(
  surveyId: string,
): Promise<Pick<SurveyRow, 'status' | 'rating' | 'comment'> | null> {
  const [row] = await db
    .select({ status: appSurveyStatus, rating: csatSurveys.rating, comment: csatSurveys.comment })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId))
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
    status: row.status,
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
 *
 * "Not expired" is asked again under the ticket's lock, where the rating is
 * written (`ratable: ['sent']`), not only off the read above: a newer survey
 * sent between the two supersedes this one, and a rating recorded on it then
 * landed on the survey the guard exists to refuse, while the answer drew the
 * newer one unanswered and asked the user again. And the answer is this
 * survey as it stands afterwards, re-read by its id, never the ticket's
 * survey read again, which a send in the same moment would make another one.
 */
export async function answerSurvey(
  caller: Caller,
  ticketId: string,
  rating: number,
  comment: string | null,
): Promise<SurveyView | null> {
  const row = await currentSurvey(caller, ticketId);
  if (!row) return null;
  if (row.status === 'expired') return surveyView(row);
  await recordAnswer(row.id, rating, comment, 'api', { ratable: ['sent'] });
  const after = await answerOf(row.id);
  return surveyView(after ? { ...row, ...after } : row);
}
