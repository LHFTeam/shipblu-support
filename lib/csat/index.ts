import { and, desc, eq, gt, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, csatSurveys, jobs, messages } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { publicBaseUrl } from '@/lib/kb/site';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/log';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { writeAutomatedReply } from '@/lib/tickets/outbound';
import type { SurveyTrigger } from './decision';
import { loadCsatSettings } from './settings';
import type { SkipReason } from './skip-reasons';

const log = logger('csat');

/**
 * Customer satisfaction surveys.
 *
 * One survey per resolution, sent on the channel the conversation happened on,
 * answered without signing in. The link carries a random token and only its
 * SHA-256 is stored, exactly as sessions do: a leaked database yields no way to
 * answer surveys as somebody else, and no way to enumerate them.
 *
 * Every decision is a row. A ticket that was not surveyed has a `skipped` row
 * saying why, so the sidebar can tell the agent who resolved it and the report
 * can say how many resolutions were asked about at all. `send_csat` decides;
 * this module writes what it decided and reads it back.
 */

/** Timeline actor for everything the survey machinery writes. */
const ACTOR = 'csat';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Queues the survey for a ticket that just reached a resolved status.
 *
 * Not immediate. A customer who replies "actually, one more thing" a minute
 * after an agent resolves the ticket should get their answer, not a
 * satisfaction survey — the delay lets the reopen happen first, and the job
 * re-checks that the ticket is still resolved before sending.
 *
 * **No dedupe key.** The key this used to carry (`csat:<conversationId>`) is
 * spent for good — `jobs_dedupe_idx` matches a job that completed months ago —
 * so a ticket reopened and resolved again was never surveyed twice, and the
 * resurvey window was unreachable. The job is idempotent instead: `sendSurvey`
 * refuses a second survey inside the window under a lock on the ticket.
 *
 * Nothing is queued while the switch is off: a ticket resolved while surveys
 * were off is not surveyed when they come on. The answer says which, so the
 * sidebar's "Send now" can tell the agent.
 */
export async function scheduleSurvey(
  conversationId: string,
  trigger: SurveyTrigger,
): Promise<'queued' | 'off' | 'unknown'> {
  try {
    const settings = await loadCsatSettings();
    if (!settings.enabled) return 'off';

    const rows = await db
      .select({ channel: conversations.channel })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const channel = rows[0]?.channel;
    if (!channel) return 'unknown';

    const isMeta = channel === 'facebook' || channel === 'instagram';
    const delayMinutes =
      trigger === 'manual'
        ? 0
        : ((isMeta ? settings.metaDelayMinutes : null) ?? settings.delayMinutes);

    await enqueue(
      'send_csat',
      { conversationId, trigger },
      { runAt: new Date(Date.now() + delayMinutes * 60_000), priority: 50 },
    );
    return 'queued';
  } catch (error) {
    log.error(`could not schedule a survey for ${conversationId}`, error);
    return 'unknown';
  }
}

/** Who handled the ticket when the decision was taken, frozen on the row. */
export type SurveySnapshot = {
  agentId: string | null;
  groupId: string | null;
  channel: ConversationChannel;
};

/** Records that no survey went out, and why, where the agent who resolved the ticket will see it. */
export async function recordSkip(
  conversationId: string,
  reason: SkipReason,
  snapshot: SurveySnapshot,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(csatSurveys).values({
      conversationId,
      status: 'skipped',
      skipReason: reason,
      agentId: snapshot.agentId,
      groupId: snapshot.groupId,
      channel: snapshot.channel,
    });

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'csat_skipped',
      actorLabel: ACTOR,
      data: { reason },
    });
  });
}

/** True when this ticket carries a survey sent inside the resurvey window. */
async function surveyedWithin(tx: Tx, conversationId: string, days: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - days * 24 * 3_600_000);

  const rows = await tx
    .select({ id: csatSurveys.id })
    .from(csatSurveys)
    .where(
      and(
        eq(csatSurveys.conversationId, conversationId),
        inArray(csatSurveys.status, ['sent', 'answered', 'expired']),
        gt(csatSurveys.sentAt, cutoff),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export type SurveySend = {
  conversationId: string;
  /** `ar` or `en`: what it goes out in. */
  locale: 'ar' | 'en';
  delivery: 'email_link' | 'text_link';
  snapshot: SurveySnapshot;
  /** `csat_settings.resurvey_after_days`, read by the job. */
  resurveyAfterDays: number;
  /** The requester's address, where the carrier is email. */
  requesterEmail: string | null;
  /** The message, given the link it will carry. */
  body: (url: string) => { text: string; html: string | null };
};

export type SentSurvey = { surveyId: string; messageId: string };

/**
 * Writes the survey and the message that carries it, as one transaction, and
 * returns their ids — or null when the ticket already carries a survey inside
 * the window, which is the whole of this module's idempotency:
 *
 * - **The ticket row is locked first.** Two jobs for one ticket — a resolve,
 *   a reopen and a resolve seconds apart, or "Send now" pressed twice — run
 *   at once in the worker pool, and a check made before either writes lets
 *   both through. Behind the lock, the second reads the first's row.
 * - **The survey, the message and the event commit together.** A worker
 *   stopped between them, or a pool error on the way, left a `sent` row with
 *   no message, which the retry counted as surveyed; the customer never got
 *   it while the sidebar said it went. Only the carrier job is queued after
 *   the commit (`enqueueAutomatedDelivery`), and it is keyed on the message,
 *   so a retry can queue it again and queue nothing.
 * - **The ticket's last survey, unanswered, is superseded.** Most are never
 *   answered, so without this the next resolution would meet
 *   `csat_surveys_open_idx` on the old row and the job would die. Its link
 *   still records an answer if the customer gets round to it.
 *
 * The raw token exists only in the link — it is hashed on the way into the
 * database and never recoverable — so a survey link that gets lost cannot be
 * looked up and resent, only reissued.
 */
export async function sendSurvey(send: SurveySend): Promise<SentSurvey | null> {
  const token = generateToken();
  const url = `${publicBaseUrl()}/${send.locale}/csat/${token}`;

  return db.transaction(async (tx) => {
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, send.conversationId))
      .for('update');

    if (await surveyedWithin(tx, send.conversationId, send.resurveyAfterDays)) return null;

    await tx
      .update(csatSurveys)
      .set({ status: 'expired' })
      .where(
        and(eq(csatSurveys.conversationId, send.conversationId), eq(csatSurveys.status, 'sent')),
      );

    const rows = await tx
      .insert(csatSurveys)
      .values({
        conversationId: send.conversationId,
        status: 'sent',
        tokenHash: hashToken(token),
        // Snapshotted at send time: reassigning the ticket next week must not
        // silently move this score onto somebody else's record.
        agentId: send.snapshot.agentId,
        groupId: send.snapshot.groupId,
        channel: send.snapshot.channel,
        delivery: send.delivery,
        locale: send.locale,
        sentAt: new Date(),
      })
      .returning({ id: csatSurveys.id });
    const surveyId = rows[0]!.id;

    const body = send.body(url);
    const messageId = await writeAutomatedReply(
      tx,
      {
        conversationId: send.conversationId,
        channel: send.snapshot.channel,
        requesterEmail: send.requesterEmail,
        bodyText: body.text,
        bodyHtml: body.html,
        actorLabel: ACTOR,
        eventType: 'csat_sent',
        eventData: { surveyId, delivery: send.delivery, locale: send.locale },
        meta: { csatSurveyId: surveyId },
      },
      // A survey is not the acknowledgement the rule engine looks for; the
      // ticket is resolved, and a rule keyed off "already acknowledged" must
      // not read one as that.
      { stampFirstAutoReply: false },
    );

    await tx.update(csatSurveys).set({ messageId }).where(eq(csatSurveys.id, surveyId));

    return { surveyId, messageId };
  });
}

/**
 * A survey this ticket carries whose message never got a carrier job: the
 * run that wrote it was stopped between its commit and the enqueue. The job
 * queues the carrier for it and nothing else.
 */
export async function unsentSurveyMessage(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ messageId: messages.id })
    .from(csatSurveys)
    .innerJoin(messages, eq(messages.id, csatSurveys.messageId))
    .where(
      and(
        eq(csatSurveys.conversationId, conversationId),
        eq(csatSurveys.status, 'sent'),
        eq(messages.deliveryStatus, 'pending'),
        notExists(
          db
            .select({ one: sql`1` })
            .from(jobs)
            .where(eq(jobs.dedupeKey, sql`'send:' || ${messages.id}::text`)),
        ),
      ),
    )
    .limit(1);

  return rows[0]?.messageId ?? null;
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
    .set({ status: 'answered', rating, comment: trimmed, respondedAt: new Date() })
    .where(and(eq(csatSurveys.tokenHash, tokenHash), isNull(csatSurveys.respondedAt)))
    .returning({ id: csatSurveys.id, conversationId: csatSurveys.conversationId });

  if (rated[0]) {
    // On the timeline, so the agent who handled the ticket sees the score
    // against the conversation rather than only in an aggregate report.
    await db.insert(conversationEvents).values({
      conversationId: rated[0].conversationId,
      type: 'csat_received',
      actorLabel: ACTOR,
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

// --- What the console reads back --------------------------------------------

/** The newest decision on a ticket, for its sidebar. */
export type SurveySummary = {
  id: string;
  status: 'sent' | 'answered' | 'skipped' | 'expired';
  skipReason: string | null;
  delivery: string | null;
  rating: number | null;
  comment: string | null;
  createdAt: Date;
  sentAt: Date | null;
  respondedAt: Date | null;
};

const SUMMARY = {
  id: csatSurveys.id,
  status: csatSurveys.status,
  skipReason: csatSurveys.skipReason,
  delivery: csatSurveys.delivery,
  rating: csatSurveys.rating,
  comment: csatSurveys.comment,
  createdAt: csatSurveys.createdAt,
  sentAt: csatSurveys.sentAt,
  respondedAt: csatSurveys.respondedAt,
};

/**
 * The newest row is the newest decision: a second job inside the window
 * writes nothing (`sendSurvey`), so a survey that went out is not buried
 * under a note saying it already had.
 */
export async function latestSurvey(conversationId: string): Promise<SurveySummary | null> {
  const rows = await db
    .select(SUMMARY)
    .from(csatSurveys)
    .where(eq(csatSurveys.conversationId, conversationId))
    .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id))
    .limit(1);

  return rows[0] ?? null;
}

/** One row of the admin page's recent list: the summary plus which ticket it was. */
export type RecentSurvey = SurveySummary & {
  conversationId: string;
  number: number;
  channel: string | null;
};

/** The newest decisions across every ticket, for the admin page. */
export async function recentSurveys(limit: number): Promise<RecentSurvey[]> {
  return db
    .select({
      ...SUMMARY,
      conversationId: csatSurveys.conversationId,
      number: conversations.number,
      channel: csatSurveys.channel,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id))
    .limit(limit);
}

/**
 * An agent's "don't survey this ticket", and its undo, on the timeline.
 *
 * A column rather than a skipped row written now, because the survey has not
 * been decided yet — the job reads the flag when it runs, so the toggle works
 * until the moment the survey goes out.
 */
export async function setSurveySuppressed(
  conversationId: string,
  agentId: string,
  suppressed: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ csatSuppressed: suppressed })
      .where(eq(conversations.id, conversationId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: suppressed ? 'csat_suppressed' : 'csat_unsuppressed',
      actorAgentId: agentId,
      data: {},
    });
  });
}
