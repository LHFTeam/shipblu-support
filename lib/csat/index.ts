import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  not,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { publicBaseUrl } from '@/lib/kb/site';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/log';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { writeAutomatedReply } from '@/lib/tickets/outbound';
import {
  channelSwitch,
  surveyAvailability,
  type SurveyAvailability,
  type SurveyTrigger,
} from './decision';
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
    if (!settings.enabled) return 'off';

    const rows = await db
      .select({ channel: conversations.channel })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const channel = rows[0]?.channel;
    if (!channel) return 'unknown';

    const key = channelSwitch(channel);
    if (key === null) return 'channel_unsupported';
    if (!settings.channels[key]) return 'channel_off';

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
 * are bounded by presses, and the button is hidden while one is queued.
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
  // categoriser does: neither row above notifies, and an agent who pressed
  // "Send now" is waiting on the open ticket for this answer. Delivered at
  // commit, so the refresh it causes reads the skip; `updated_at` is no queue
  // column, so it wakes this ticket and no queue.
  await tx
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** The row lock every write on a ticket's surveys takes first, so two jobs for one ticket queue behind each other. */
async function lockTicket(tx: Tx, conversationId: string): Promise<void> {
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
}

/**
 * True when this ticket carries a survey sent inside the resurvey window —
 * one the customer could have been sent, which an abandoned one never was.
 */
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
        not(stranded('abandoned')),
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
  /** The wording rule it goes out with, for the page to ask the same question. */
  ruleId: string | null;
  /** The requester's address, where the carrier is email. */
  requesterEmail: string | null;
  /** The message, given the link it will carry. */
  body: (url: string) => { text: string; html: string | null };
};

export type SendOutcome =
  | { kind: 'sent'; surveyId: string; messageId: string }
  /** The ticket already carries a survey inside the window; nothing was written. */
  | { kind: 'surveyed' }
  /** The ticket changed under the job since it decided; the reason is the job's to record. */
  | { kind: 'skip'; reason: 'reopened' | 'agent_suppressed' }
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
 *   case the delay exists for, so the status and the agent's flag are read
 *   again here, where nothing can change them until the commit.
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
export async function sendSurvey(send: SurveySend): Promise<SendOutcome> {
  const token = generateToken();
  const url = `${publicBaseUrl()}/${send.locale}/csat/${token}`;

  return db.transaction(async (tx) => {
    await lockTicket(tx, send.conversationId);

    const [ticket] = await tx
      .select({
        deletedAt: conversations.deletedAt,
        isSpam: conversations.isSpam,
        mergedIntoId: conversations.mergedIntoId,
        csatSuppressed: conversations.csatSuppressed,
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
    if (ticket.csatSuppressed) return { kind: 'skip', reason: 'agent_suppressed' };

    if (await surveyedWithin(tx, send.conversationId, send.resurveyAfterDays)) {
      return { kind: 'surveyed' };
    }

    // An abandoned survey is retired with the rest below, and its message
    // said to have gone nowhere: left `pending`, the timeline shows it
    // sending for good, just above the survey that replaces it.
    await tx
      .update(messages)
      .set({
        deliveryStatus: 'failed',
        deliveryError: 'never sent, and a later survey replaced it',
      })
      .where(
        inArray(
          messages.id,
          tx
            .select({ id: csatSurveys.messageId })
            .from(csatSurveys)
            .where(and(eq(csatSurveys.conversationId, send.conversationId), stranded('abandoned'))),
        ),
      );

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
        meta: { csatSurveyId: surveyId },
      },
      // A survey is not the acknowledgement the rule engine looks for; the
      // ticket is resolved, and a rule keyed off "already acknowledged" must
      // not read one as that.
      { stampFirstAutoReply: false },
    );

    await tx.update(csatSurveys).set({ messageId }).where(eq(csatSurveys.id, surveyId));

    return { kind: 'sent', surveyId, messageId };
  });
}

/**
 * A survey whose message never got a carrier job: the run that wrote it was
 * stopped between its commit and the enqueue. One predicate read two ways by
 * its age, so the job that owes a carrier and the window that counts a survey
 * cannot disagree about the same row:
 *
 * - **Owed, for a day.** The run that strands a carrier is retried within
 *   minutes, so this is almost always found the same hour, and the next job
 *   queues the carrier before deciding anything (`unsentSurveyMessage`). The
 *   bound is also what keeps two jobs from sending twice: a run that has just
 *   committed and not yet queued looks exactly like this to the job holding
 *   the lock after it, which must count it as sent.
 * - **Abandoned, after that.** It is about a resolution long past — its
 *   carrier purged, or a retry that never came — so sending it now would ask
 *   about that as though it were the resolution in front of the customer. Nor
 *   does it count as surveyed (`surveyedWithin`): the customer never got it,
 *   and counted, it refused every survey until the window ran out while the
 *   sidebar said one had gone and hid "Send now".
 */
const OWED_FOR_MS = 24 * 3_600_000;

function stranded(age: 'owed' | 'abandoned'): SQL {
  const owedSince = new Date(Date.now() - OWED_FOR_MS);

  return and(
    eq(csatSurveys.status, 'sent'),
    age === 'owed' ? gt(csatSurveys.sentAt, owedSince) : lte(csatSurveys.sentAt, owedSince),
    exists(
      db
        .select({ one: sql`1` })
        .from(messages)
        .where(
          and(
            eq(messages.id, csatSurveys.messageId),
            eq(messages.deliveryStatus, 'pending'),
            notExists(
              db
                .select({ one: sql`1` })
                .from(jobs)
                .where(eq(jobs.dedupeKey, sql`'send:' || ${messages.id}::text`)),
            ),
          ),
        ),
    ),
  )!;
}

/** The message of a survey still owed its carrier, queued before the job decides anything else. */
export async function unsentSurveyMessage(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ messageId: csatSurveys.messageId })
    .from(csatSurveys)
    .where(and(eq(csatSurveys.conversationId, conversationId), stranded('owed')))
    .limit(1);

  return rows[0]?.messageId ?? null;
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
  const [rows, settings] = await Promise.all([
    db
      .select(SUMMARY)
      .from(csatSurveys)
      .where(eq(csatSurveys.conversationId, conversationId))
      .orderBy(desc(csatSurveys.createdAt), desc(csatSurveys.id)),
    // The sidebar's memoised read. A failed one is null, which is `unknown`:
    // "Send now" is hidden and nothing is said about the switch until the
    // next render reads it again.
    loadCsatSettings(),
  ]);

  // Newest first, so the newest decision is the first row.
  const latest = rows[0] ?? null;
  const survey =
    rows.find((row) => row.status === 'answered') ??
    rows.find((row) => row.status !== 'skipped') ??
    null;

  return {
    survey,
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
      data: {},
    });
  });
}
