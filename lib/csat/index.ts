import { and, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversations,
  csatSurveys,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { publicBaseUrl } from '@/lib/kb/site';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/log';
import { isMetaChannel, type ConversationChannel } from '@/lib/tickets/channel-policy';
import { enqueueAutomatedDelivery, writeAutomatedReply } from '@/lib/tickets/outbound';
import {
  isClosedChat,
  suppressionReason,
  surveyAvailability,
  type SuppressedBy,
  type SurveyAvailability,
  type SurveyTrigger,
} from './decision';
import { carriesLink, type AnswerSource, type SurveyDelivery } from './delivery';
import type { SurveyMessageMeta } from './meta-survey';
import { LOW_RATING_MAX, MAX_COMMENT } from './limits';
import { ALERT_PRIORITY } from './low-rating';
import { loadCsatSettings, readCsatSettings } from './settings';
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

/** The survey's carrier priority: behind an acknowledgement, which a customer is waiting on. */
const CARRIER_PRIORITY = 50;

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
 * Nothing is queued while the switch is off, or for a channel that is off or
 * has no switch: a ticket resolved then is not surveyed when the switch comes
 * on, and a WhatsApp resolution does not cost a job, a row and a timeline
 * event for a fixed answer. The answer says which, so the sidebar's "Send
 * now" can tell the agent. A settings read that fails is `unknown`, never
 * `off`: the agent is told nothing could be queued, not that a switch is off.
 */
export type ScheduleOutcome = 'queued' | 'off' | 'channel_off' | 'channel_unsupported' | 'unknown';

export async function scheduleSurvey(
  conversationId: string,
  trigger: SurveyTrigger,
): Promise<ScheduleOutcome> {
  try {
    const settings = await readCsatSettings();

    const rows = await db
      .select({ channel: conversations.channel })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const channel = rows[0]?.channel;
    if (!channel) return 'unknown';

    // The sidebar's own question, so the two cannot answer the same ticket
    // differently — a WhatsApp ticket is "not sent on this channel" to both,
    // whatever the switch says.
    const availability = surveyAvailability(settings, channel);
    if (availability === 'unsupported') return 'channel_unsupported';
    if (availability !== 'on') return availability;

    const isMeta = isMetaChannel(channel);
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

/**
 * Records that no survey went out, and why, where the agent who resolved the
 * ticket will see it. Returns whether a row was written.
 *
 * Under the ticket lock, and once: an agent toggling a ticket resolved, open
 * and resolved again while tidying their queue runs the job twice, and two
 * rows saying the same thing an hour apart tell nobody anything. The same
 * reason within a day is the earlier row's; a different reason, or the same
 * one a day later, is a new decision.
 *
 * Except when somebody asked (`repeat`): an agent who pressed "Send now" is
 * waiting on the ticket for the answer, and the sidebar clears its "queued"
 * line when a new decision lands. Folded into the earlier row, the same
 * answer is no answer — the line stays and the button stays gone. The rows
 * are bounded by runs of the job: one per press, the button hidden while one
 * is queued, and a second only when a worker stopped mid-run runs it again.
 */
const SAME_SKIP_WITHIN_MS = 24 * 3_600_000;

export async function recordSkip(
  conversationId: string,
  reason: SkipReason,
  snapshot: SurveySnapshot,
  { repeat = false }: { repeat?: boolean } = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockTicket(tx, conversationId);

    if (repeat) {
      await writeSkip(tx, conversationId, reason, snapshot);
      return true;
    }

    const [newest] = await tx
      .select({
        status: csatSurveys.status,
        skipReason: csatSurveys.skipReason,
        createdAt: csatSurveys.createdAt,
      })
      .from(csatSurveys)
      .where(eq(csatSurveys.conversationId, conversationId))
      .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id))
      .limit(1);
    if (
      newest?.status === 'skipped' &&
      newest.skipReason === reason &&
      Date.now() - newest.createdAt.getTime() < SAME_SKIP_WITHIN_MS
    ) {
      return false;
    }

    await writeSkip(tx, conversationId, reason, snapshot);
    return true;
  });
}

async function writeSkip(
  tx: Tx,
  conversationId: string,
  reason: SkipReason,
  snapshot: SurveySnapshot,
): Promise<void> {
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

  // Touch the conversation so its `notify_change` trigger fires, as the
  // subcategoriser does: neither row above notifies, and an agent who pressed
  // "Send now" is waiting on the open ticket for this answer. Delivered at
  // commit, so the refresh it causes reads the skip; `updated_at` is no queue
  // column, so it wakes this ticket and no queue.
  await tx
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * The ticket's row lock, taken first by every write that changes a ticket's
 * surveys and writes its timeline too — so two jobs for one ticket queue
 * behind each other, and the event's foreign key, which locks the ticket,
 * never comes second to a survey's row. The one write without it is a
 * comment added to an answered survey (`recordAnswer`): one row and no event,
 * waiting on nothing that could close a cycle.
 */
async function lockTicket(tx: Tx, conversationId: string): Promise<void> {
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
}

/** True when this ticket carries a survey sent inside the resurvey window. */
async function surveyedWithin(tx: Tx, conversationId: string, days: number): Promise<boolean> {
  // Never below a day, whatever the row says (`MIN_RESURVEY_DAYS`): at zero
  // the window is empty and every job for a ticket sends.
  const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3_600_000);

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
  delivery: SurveyDelivery;
  snapshot: SurveySnapshot;
  /** `csat_settings.resurvey_after_days`, read by the job. */
  resurveyAfterDays: number;
  /** The wording rule it goes out with, for the page to ask the same question. */
  ruleId: string | null;
  /** The requester's address, where the carrier is email. */
  requesterEmail: string | null;
  /**
   * The message, given the link it will carry — none on Meta's two
   * deliveries (`carriesLink`), whose answer comes back on Meta's own
   * webhook — and anything its carrier needs on the row besides the text.
   */
  body: (url: string | null) => {
    text: string;
    html: string | null;
    meta?: Record<string, unknown>;
  };
};

export type SendOutcome =
  | { kind: 'sent'; surveyId: string; messageId: string }
  /** The ticket already carries a survey inside the window; nothing was written. */
  | { kind: 'surveyed' }
  /** The ticket changed under the job since it decided; the reason is the job's to record. */
  | { kind: 'skip'; reason: 'reopened' | 'chat_closed' | 'agent_suppressed' | 'rule_suppressed' }
  /** The ticket is gone. */
  | { kind: 'drop' };

/**
 * Writes the survey and the message that carries it, as one transaction, and
 * says what happened — which is the whole of this module's idempotency:
 *
 * - **The ticket row is locked first, and the decision's facts re-read behind
 *   it.** Two jobs for one ticket — a resolve, a reopen and a resolve seconds
 *   apart, or "Send now" pressed twice — run at once in the worker pool, and a
 *   check made before either writes lets both through. And a customer whose
 *   reply reopened the ticket between the job's read and this write is the
 *   case the delay exists for, so the status and the "don't survey" flag
 *   are read again here, where nothing can change them until the commit.
 * - **The survey, the message, the event and the carrier job commit
 *   together.** A worker stopped between them, or a pool error on the way,
 *   left a `sent` row with no message, which the retry counted as surveyed;
 *   the customer never got it while the sidebar said it went. The carrier
 *   was once queued after the commit, and a run stopped between the two left
 *   a survey with no job to send it — which took a day-bounded "owed" check,
 *   an "abandoned" one and a retirement of its message to make right. Queued
 *   on the same transaction (`enqueueAutomatedDelivery(…, tx)`), the job
 *   exists exactly when its survey does, and the worker cannot see it
 *   before.
 * - **The ticket's last survey, unanswered, is superseded.** Most are never
 *   answered, so without this the next resolution would meet
 *   `csat_surveys_open_idx` on the old row and the job would die. Its link
 *   still records an answer if the customer gets round to it.
 *
 * The raw token exists only in the link — it is hashed on the way into the
 * database and never recoverable — so a survey link that gets lost cannot be
 * looked up and resent, only reissued.
 */
export async function sendSurvey(send: SurveySend): Promise<SendOutcome> {
  // No link where nothing would carry it: a token nobody holds is a hash
  // with no door, and `token_hash` is nullable for exactly this.
  const token = carriesLink(send.delivery) ? generateToken() : null;
  const url = token ? `${publicBaseUrl()}/${send.locale}/csat/${token}` : null;

  return db.transaction(async (tx) => {
    await lockTicket(tx, send.conversationId);

    const [ticket] = await tx
      .select({
        deletedAt: conversations.deletedAt,
        isSpam: conversations.isSpam,
        mergedIntoId: conversations.mergedIntoId,
        suppressedBy: suppressedBy(),
        statusCategory: ticketStatuses.category,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(eq(conversations.id, send.conversationId))
      .limit(1);
    if (!ticket || ticket.deletedAt || ticket.isSpam || ticket.mergedIntoId)
      return { kind: 'drop' };
    if (ticket.statusCategory !== 'resolved' && ticket.statusCategory !== 'closed') {
      return { kind: 'skip', reason: 'reopened' };
    }
    if (ticket.suppressedBy !== null) {
      return { kind: 'skip', reason: suppressionReason(ticket.suppressedBy) };
    }
    // `decideSurvey`'s rule, again behind the lock and in its order — after
    // the agent's or the rule's flag: closed in between, a chat is one the
    // visitor can no longer open.
    if (isClosedChat(send.snapshot.channel, ticket.statusCategory)) {
      return { kind: 'skip', reason: 'chat_closed' };
    }

    if (await surveyedWithin(tx, send.conversationId, send.resurveyAfterDays)) {
      return { kind: 'surveyed' };
    }

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
        tokenHash: token ? hashToken(token) : null,
        // Snapshotted at send time: reassigning the ticket next week must not
        // silently move this score onto somebody else's record.
        agentId: send.snapshot.agentId,
        groupId: send.snapshot.groupId,
        channel: send.snapshot.channel,
        delivery: send.delivery,
        locale: send.locale,
        ruleId: send.ruleId,
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
        meta: { ...body.meta, csatSurveyId: surveyId } satisfies Pick<
          SurveyMessageMeta,
          'csatSurveyId'
        >,
      },
      // A survey is not the acknowledgement the rule engine looks for; the
      // ticket is resolved, and a rule keyed off "already acknowledged" must
      // not read one as that.
      { stampFirstAutoReply: false },
    );

    await tx.update(csatSurveys).set({ messageId }).where(eq(csatSurveys.id, surveyId));
    await enqueueAutomatedDelivery(send.snapshot.channel, messageId, CARRIER_PRIORITY, tx);

    return { kind: 'sent', surveyId, messageId };
  });
}

/**
 * Messenger refused its feedback card for this survey, and the carrier is
 * sending it as quick replies instead (`send_meta`): the row, the message and
 * the timeline say so. The message's `sendKind` is what a retry of the
 * carrier reads, so it moves in the same transaction as the delivery the
 * sidebar reads, and the timeline's line is written once, by whichever run
 * moved the row.
 */
export async function fallBackToQuickReplies(surveyId: string, messageId: string): Promise<void> {
  const [subject] = await db
    .select({ conversationId: csatSurveys.conversationId })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId))
    .limit(1);

  await db.transaction(async (tx) => {
    // The ticket first, then the survey's row, as every write that touches
    // both takes them (`lockTicket`): the event below locks the ticket
    // through its foreign key, and taking that after the survey's row would
    // deadlock against an answer being recorded on the same survey.
    if (subject) await lockTicket(tx, subject.conversationId);

    const moved = await tx
      .update(csatSurveys)
      .set({ delivery: 'meta_quick_reply' })
      .where(and(eq(csatSurveys.id, surveyId), eq(csatSurveys.delivery, 'meta_template')))
      .returning({ conversationId: csatSurveys.conversationId });

    await tx
      .update(messages)
      .set({
        meta: sql`jsonb_set(${messages.meta}, '{sendKind}', '"quick_reply_survey"'::jsonb)`,
      })
      .where(eq(messages.id, messageId));

    if (moved[0]) {
      await tx.insert(conversationEvents).values({
        conversationId: moved[0].conversationId,
        type: 'csat_fell_back',
        actorLabel: ACTOR,
        data: { surveyId, delivery: 'meta_quick_reply' },
      });
    }
  });
}

export type SurveyView = {
  id: string;
  conversationId: string;
  rating: number | null;
  respondedAt: Date | null;
  /** The wording it went out with; null for the built-in. */
  ruleId: string | null;
};

export async function surveyByToken(token: string): Promise<SurveyView | null> {
  if (!token) return null;

  const rows = await db
    .select({
      id: csatSurveys.id,
      conversationId: csatSurveys.conversationId,
      rating: csatSurveys.rating,
      respondedAt: csatSurveys.respondedAt,
      ruleId: csatSurveys.ruleId,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.tokenHash, hashToken(token)))
    .limit(1);

  return rows[0] ?? null;
}

export type ResponseOutcome = 'recorded' | 'comment_added' | 'ignored';

/**
 * Records an answer, whichever door it came through — the page a link opens,
 * or the card in the chat widget — so the rules below are one function's and
 * no door can answer them differently. The caller has already established
 * that whoever is answering may: the page by the token in its link, the widget
 * by the visitor's own session.
 *
 * The score and the comment arrive as two requests, because both doors save
 * the rating the moment it is chosen — most people answer the number and
 * leave, and making them press Send afterwards is how a survey loses the
 * responses it did get. So this handles both:
 *
 * - No answer yet: the rating is recorded, with where it came from. First
 *   answer wins, enforced by requiring `responded_at` to still be null, so a
 *   link forwarded to a colleague cannot overwrite what the customer said.
 *   A superseded survey still takes one, as its link always did; a skipped
 *   row never does, because there was no survey to answer.
 * - Already answered, comment still empty: the comment is attached without
 *   touching the score. That is the same customer finishing their sentence.
 * - Anything else: ignored.
 */
export async function recordAnswer(
  surveyId: string,
  rating: number,
  comment: string | null,
  source: AnswerSource,
): Promise<ResponseOutcome> {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'ignored';

  const trimmed = comment ? comment.trim().slice(0, MAX_COMMENT) || null : null;

  const [subject] = await db
    .select({ conversationId: csatSurveys.conversationId, respondedAt: csatSurveys.respondedAt })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId))
    .limit(1);
  if (!subject) return 'ignored';

  // Already answered — the comment after the tap, the normal second request,
  // or a tap delivered twice — needs no rating, so takes no lock on the
  // ticket: straight to the comment. An answer landing between this read and
  // the transaction is still refused there, by the update's own
  // `responded_at is null`.
  if (
    subject.respondedAt === null &&
    (await recordRating(surveyId, subject.conversationId, rating, trimmed, source))
  ) {
    return 'recorded';
  }

  if (!trimmed) return 'ignored';

  const commented = await db
    .update(csatSurveys)
    .set({ comment: trimmed })
    .where(
      and(
        eq(csatSurveys.id, surveyId),
        eq(csatSurveys.status, 'answered'),
        isNull(csatSurveys.comment),
      ),
    )
    .returning({ id: csatSurveys.id });

  return commented[0] ? 'comment_added' : 'ignored';
}

/**
 * The first answer: the rating, its event and, for a low one, its alert, in
 * one transaction, so a low rating's alert is queued exactly when the rating
 * is recorded — never for a tap that lost to an earlier answer, never lost to
 * a process that died between the two. The ticket's lock comes first, as in
 * `sendSurvey`, which holds it while it supersedes this ticket's older
 * surveys: taking the survey's row first and the ticket's (the event's
 * foreign key) second would deadlock against it. False when an earlier
 * answer was there first.
 */
async function recordRating(
  surveyId: string,
  conversationId: string,
  rating: number,
  comment: string | null,
  source: AnswerSource,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockTicket(tx, conversationId);

    const rated = await tx
      .update(csatSurveys)
      .set({ status: 'answered', rating, comment, respondedAt: new Date(), answerSource: source })
      .where(
        and(
          eq(csatSurveys.id, surveyId),
          inArray(csatSurveys.status, ['sent', 'expired']),
          isNull(csatSurveys.respondedAt),
        ),
      )
      .returning({ id: csatSurveys.id });

    if (!rated[0]) return false;

    // On the timeline, so the agent who handled the ticket sees the score
    // against the conversation rather than only in an aggregate report.
    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'csat_received',
      actorLabel: ACTOR,
      data: { rating, source },
    });

    // The job decides whether anybody is told (`notify_low_rating`): the
    // switch is read when it runs, so turning alerts off stops the ones
    // already queued, and nothing about who is told slows the customer's tap.
    if (rating <= LOW_RATING_MAX) {
      await enqueue('notify_low_rating', { surveyId }, { on: tx, priority: ALERT_PRIORITY });
    }

    return true;
  });
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
 * What the sidebar shows: the ticket's survey — the newest answered one, else
 * the newest sent or superseded one — and, when the newest decision was not
 * to send another, that decision. Two things rather than the newest row,
 * because a `skipped` row written after an answered survey (the ticket
 * reopened and was resolved again inside the window) must not bury the
 * customer's rating; and the answered one first, because a customer who
 * answers a superseded link has still rated the ticket, and a newer survey
 * "no answer yet" on top of that rating hides it.
 */
export type TicketSurveyState = {
  survey: SurveySummary | null;
  /** A survey sent after the answered one shown, still unanswered. */
  newer: { sentAt: Date | null } | null;
  /**
   * The newest decision, when it was not to survey. Not merely newer than
   * `survey`: a survey sent after the skip answers it, even under an older
   * answered one that stays on screen.
   */
  skip: { reason: string | null; createdAt: Date } | null;
  /**
   * The newest decision of any kind, which the sidebar's "queued" line is
   * remembered against: whatever the job decides, a survey or a skip, is a new
   * row and clears it. Keyed on what is shown instead, a survey sent under an
   * older answered one changed nothing on screen, and the line never cleared.
   */
  latestId: string | null;
  /** Whether a survey could go out on this ticket's channel right now (`surveyAvailability`). */
  availability: SurveyAvailability;
};

export async function ticketSurveyState(
  conversationId: string,
  channel: string,
): Promise<TicketSurveyState> {
  // The sidebar's memoised read. A failed one is null, which is `unknown`:
  // "Send now" is hidden and nothing is said about the switch until the next
  // render reads it again. Read before the rows rather than beside them: this
  // runs as one lane of the ticket page's `allLimited` reads, and two at once
  // would take a second place in the pool for it.
  const settings = await loadCsatSettings();
  const rows = await db
    .select(SUMMARY)
    .from(csatSurveys)
    .where(eq(csatSurveys.conversationId, conversationId))
    .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id));

  // Newest first, so the newest decision is the first row.
  const latest = rows[0] ?? null;
  const survey =
    rows.find((row) => row.status === 'answered') ??
    rows.find((row) => row.status !== 'skipped') ??
    null;

  // A survey sent after the rating shown — "Send now" on a ticket rated
  // weeks ago — is on its way, and says so beside the rating it sits under.
  const newer =
    survey?.status === 'answered'
      ? (rows.find((row) => row.status === 'sent' && row.createdAt > survey.createdAt) ?? null)
      : null;

  return {
    survey,
    newer: newer ? { sentAt: newer.sentAt } : null,
    skip:
      latest?.status === 'skipped'
        ? { reason: latest.skipReason, createdAt: latest.createdAt }
        : null,
    latestId: latest?.id ?? null,
    availability: surveyAvailability(settings, channel),
  };
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
      createdAt: DECISION_STAMP,
      data: {},
    });
  });
}

/**
 * The `created_at` of a `csat_suppressed` or `csat_unsuppressed` event, read
 * once the update before it holds the ticket's row lock — `CHANGE_STAMP`'s
 * reasoning. The column default, `now()`, is when the transaction began, so an
 * agent's toggle that began first and wrote last would sort before a rule's
 * that committed in between, and `suppressedBy` would name the rule for the
 * agent's flag; and the guard in `suppressSurveyByRule` orders an allow
 * against a rule's suppression by the same column.
 */
const DECISION_STAMP = sql<Date>`clock_timestamp()`;

/** An event a rule wrote: no agent, and the engine's `automation:` label. */
function writtenByRule(alias: SQL): SQL {
  return sql`${alias}.actor_agent_id is null and coalesce(${alias}.actor_label, '') like 'automation:%'`;
}

/**
 * A rule's `suppress_survey`: the agent's flag, set only where it changes
 * something and only where no agent has overruled a rule on the ticket.
 * Whether it changed anything is the answer, which the engine logs.
 *
 * Conditional in the statement, not on the ticket the engine read, for two
 * reasons. A rule runs again on every update it matches, and a time rule
 * over every live ticket every fifteen minutes, so writing whenever it
 * matched would put a fresh `csat_suppressed` on the timeline each time;
 * this writes the event once, on the flip. And the engine's ticket is read
 * before its first rule runs, so an earlier action or another request can
 * have changed the flag since.
 *
 * An agent who allowed a survey after a rule had kept it off keeps it
 * allowed: a `csat_unsuppressed` event, which only an agent writes, newer
 * than a rule's `csat_suppressed`, stops rules for the rest of the ticket's
 * life. Without it the next update or time rule would undo the agent's
 * choice — in the very request, when the agent resolves from the status
 * picker, which runs `on_update` right after. An agent undoing their own
 * "Don't survey" overruled no rule, so it stops none, and the sidebar warns
 * only where a rule set the flag.
 */
export async function suppressSurveyByRule(
  conversationId: string,
  ruleName: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const flipped = await tx
      .update(conversations)
      .set({ csatSuppressed: true })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.csatSuppressed, false),
          sql`not exists (
            select 1 from ${conversationEvents} allowed
            where allowed.conversation_id = ${conversations}.id
              and allowed.type = 'csat_unsuppressed'
              and exists (
                select 1 from ${conversationEvents} ruled
                where ruled.conversation_id = ${conversations}.id
                  and ruled.type = 'csat_suppressed'
                  and ${writtenByRule(sql`ruled`)}
                  and ruled.created_at < allowed.created_at
              )
          )`,
        ),
      )
      .returning({ id: conversations.id });
    if (flipped.length === 0) return false;

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'csat_suppressed',
      // No actor agent: the timeline names the rule, as every action does.
      actorLabel: `automation:${ruleName}`,
      createdAt: DECISION_STAMP,
      data: {},
    });
    return true;
  });
}

/**
 * Who keeps a ticket from being surveyed, for a query over `conversations`:
 * null when its flag is off, `rule` when the newest `csat_suppressed` event
 * is a rule's, `agent` otherwise — a flag with no event behind it included,
 * which is how every flag set before rules could set one reads.
 *
 * Off the timeline, as `resolvedByRule` reads who resolved a ticket, rather
 * than a second column beside the flag: the event already names who set it,
 * and a column would be one more thing the sidebar's toggle had to keep in
 * step. A rule's event carries no agent and a label the engine writes
 * (`automation:<rule>`); an agent's carries the agent, and a deleted agent's
 * keeps no label, so it still reads as an agent's.
 *
 * Written against `${conversations}.id` and an aliased events table rather
 * than the columns' own references: in a select from `conversations` alone,
 * drizzle renders a column reference unqualified, and a bare "id" inside the
 * subquery is the event's own id — every flag would read as an agent's
 * (`lib/admin/settings.ts` met the same thing).
 */
export function suppressedBy(): SQL<SuppressedBy | null> {
  return sql<SuppressedBy | null>`case
    when not ${conversations}.csat_suppressed then null
    when coalesce(
      (
        select ${writtenByRule(sql`e`)}
        from ${conversationEvents} e
        where e.conversation_id = ${conversations}.id and e.type = 'csat_suppressed'
        order by e.created_at desc
        limit 1
      ),
      false
    ) then 'rule'
    else 'agent'
  end`;
}
