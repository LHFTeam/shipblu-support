import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, csatSurveys } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { publicBaseUrl } from '@/lib/kb/site';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/log';

const log = logger('csat');

/**
 * Customer satisfaction surveys.
 *
 * One survey per resolution, sent on the channel the conversation happened on,
 * answered without signing in. The link carries a random token and only its
 * SHA-256 is stored, exactly as sessions do: a leaked database yields no way to
 * answer surveys as somebody else, and no way to enumerate them.
 */

/**
 * How long after resolution the survey goes out.
 *
 * Not immediate. A customer who replies "actually, one more thing" a minute
 * after an agent resolves the ticket should get their answer, not a
 * satisfaction survey — the delay lets the reopen happen first, and the job
 * re-checks that the ticket is still resolved before sending.
 */
export const SURVEY_DELAY_MS = 30 * 60_000;

/** Don't survey the same customer about the same ticket twice in a fortnight. */
const RESURVEY_AFTER_DAYS = 14;

export async function scheduleSurvey(conversationId: string): Promise<void> {
  try {
    await enqueue(
      'send_csat',
      { conversationId },
      {
        runAt: new Date(Date.now() + SURVEY_DELAY_MS),
        priority: 50,
        // One pending survey per ticket however many times an agent toggles the
        // status while tidying up their queue.
        dedupeKey: `csat:${conversationId}`,
      },
    );
  } catch (error) {
    log.error(`could not schedule a survey for ${conversationId}`, error);
  }
}

/** True when this ticket was surveyed recently enough to leave alone. */
export async function recentlySurveyed(conversationId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - RESURVEY_AFTER_DAYS * 24 * 3_600_000);

  const rows = await db
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .where(and(eq(csatSurveys.conversationId, conversationId), gt(csatSurveys.sentAt, cutoff)))
    .limit(1);

  return rows.length > 0;
}

export type NewSurvey = { id: string; url: string };

/**
 * Creates the survey row and returns the link to put in the message.
 *
 * The raw token exists only in the returned URL — it is hashed on the way into
 * the database and never recoverable — so a survey link that gets lost cannot
 * be looked up and resent, only reissued.
 */
export async function createSurvey(
  conversationId: string,
  locale: string,
  snapshot: { agentId: string | null; groupId: string | null },
): Promise<NewSurvey> {
  const token = generateToken();

  const rows = await db
    .insert(csatSurveys)
    .values({
      conversationId,
      tokenHash: hashToken(token),
      // Snapshotted at send time: reassigning the ticket next week must not
      // silently move this score onto somebody else's record.
      agentId: snapshot.agentId,
      groupId: snapshot.groupId,
      sentAt: new Date(),
    })
    .returning({ id: csatSurveys.id });

  return { id: rows[0]!.id, url: `${publicBaseUrl()}/${locale}/csat/${token}` };
}

export type SurveyView = {
  id: string;
  conversationId: string;
  rating: number | null;
  respondedAt: Date | null;
};

export async function surveyByToken(token: string): Promise<SurveyView | null> {
  if (!token) return null;

  const rows = await db
    .select({
      id: csatSurveys.id,
      conversationId: csatSurveys.conversationId,
      rating: csatSurveys.rating,
      respondedAt: csatSurveys.respondedAt,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.tokenHash, hashToken(token)))
    .limit(1);

  return rows[0] ?? null;
}

export const MAX_COMMENT = 2000;

export type ResponseOutcome = 'recorded' | 'comment_added' | 'ignored';

/**
 * Records a response.
 *
 * The score and the comment arrive as two requests, because the form saves the
 * rating the moment it is clicked — most people answer the number and leave,
 * and making them press Send afterwards is how a survey loses the responses it
 * did get. So this handles both:
 *
 * - No answer yet: the rating is recorded. First answer wins, enforced by
 *   requiring `responded_at` to still be null, so a link forwarded to a
 *   colleague cannot overwrite what the customer said.
 * - Already answered, comment still empty: the comment is attached without
 *   touching the score. That is the same customer finishing their sentence.
 * - Anything else: ignored.
 */
export async function recordResponse(
  token: string,
  rating: number,
  comment: string | null,
): Promise<ResponseOutcome> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'ignored';

  const tokenHash = hashToken(token);
  const trimmed = comment ? comment.trim().slice(0, MAX_COMMENT) || null : null;

  const rated = await db
    .update(csatSurveys)
    .set({ rating, comment: trimmed, respondedAt: new Date() })
    .where(and(eq(csatSurveys.tokenHash, tokenHash), isNull(csatSurveys.respondedAt)))
    .returning({ id: csatSurveys.id, conversationId: csatSurveys.conversationId });

  if (rated[0]) {
    // On the timeline, so the agent who handled the ticket sees the score
    // against the conversation rather than only in an aggregate report.
    await db.insert(conversationEvents).values({
      conversationId: rated[0].conversationId,
      type: 'csat_received',
      actorLabel: 'csat',
      data: { rating },
    });

    return 'recorded';
  }

  if (!trimmed) return 'ignored';

  const commented = await db
    .update(csatSurveys)
    .set({ comment: trimmed })
    .where(and(eq(csatSurveys.tokenHash, tokenHash), isNull(csatSurveys.comment)))
    .returning({ id: csatSurveys.id });

  return commented[0] ? 'comment_added' : 'ignored';
}
