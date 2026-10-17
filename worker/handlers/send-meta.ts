import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import { fallBackToQuickReplies } from '@/lib/csat';
import type { MetaSurveyMeta, SurveyMessageMeta } from '@/lib/csat/meta-survey';
import { clearTemplateRefusal, recordTemplateRefusal } from '@/lib/csat/settings';
import {
  ACCESS_TOKEN_CODE,
  MetaApiError,
  privateReplyToComment,
  replyToComment,
  sendDirectMessage,
  sendMessageRequest,
} from '@/lib/meta/client';
import { commentReplyTarget } from '@/lib/meta/comments';
import { metaConnection, type MetaConnection } from '@/lib/meta/connection';
import {
  explainMetaSendError,
  isRecipientRefusal,
  isUnspecified,
  MetaSendRefusal,
  type MetaSendContext,
} from '@/lib/meta/errors';
import { feedbackTemplateRequest } from '@/lib/meta/feedback-template';
import { quickReplySurveyRequest } from '@/lib/meta/quick-reply-survey';
import type { MetaPlatform } from '@/lib/meta/types';
import {
  feedbackTemplateTag,
  messagingTag,
  metaWindowState,
  type MetaSendAuthor,
  type MetaWindowState,
} from '@/lib/meta/window';
import { isFinalAttempt, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { alreadySent } from './already-sent';
import { subjectGone } from './subject-gone';
import { metaReplyTarget } from '@/lib/tickets/meta-thread';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('send_meta');

/**
 * Delivers an agent's Facebook or Instagram reply.
 *
 * Three different sends behind one job, because from the console they are one
 * action — "answer this customer" — and which mechanism that requires is a
 * property of the ticket, not a decision the agent should have to make:
 *
 *   dm             a direct message, tagged RESPONSE or HUMAN_AGENT
 *   comment_reply  a public reply under the customer's comment
 *   private_reply  a one-time move from a public comment into the DM inbox
 *
 * and two more that only the satisfaction survey writes, each a direct
 * message with something attached, built from what the survey job froze on
 * the row (`lib/csat/meta-survey.ts`):
 *
 *   feedback_template   Messenger's customer feedback card, tagged
 *                       CUSTOMER_FEEDBACK past the 24 hours
 *   quick_reply_survey  the question with five rating buttons under it,
 *                       inside the 24 hours only
 *
 * The console writes the message row first and enqueues this, so the agent sees
 * their reply immediately and a Meta outage delays delivery rather than losing
 * what they wrote.
 */

type SendKind = 'dm' | 'comment_reply' | 'private_reply' | MetaSurveyMeta['sendKind'];

type SendMeta = {
  metaKind?: 'direct_message' | 'comment';
  sendKind?: SendKind;
  platform?: MetaPlatform;
  commentId?: string;
  /** The customer's page-scoped id, for a DM. */
  recipientId?: string;
  /**
   * A survey message's survey, and what its carrier needs — named from the
   * type the survey writes them under, so a field renamed there is a compile
   * error here rather than every survey refused as carrying nothing to send.
   * Optional because the row's `sendKind` says which of them it carries.
   */
  csatSurveyId?: SurveyMessageMeta['csatSurveyId'];
  card?: Extract<MetaSurveyMeta, { sendKind: 'feedback_template' }>['card'];
  labels?: MetaSurveyMeta['labels'];
};

/**
 * The request a failure is explained against: what was last put to Graph,
 * which after a refused card is the quick replies sent in its place.
 */
type Attempt = {
  sendKind: SendKind;
  tag: MetaSendContext['tag'];
  /** The queue's last try at this message (`isFinalAttempt`): no retry comes after it. */
  final: boolean;
};

export async function sendMeta(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'send_meta');

  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw subjectGone('send_meta', `message ${messageId}`);

  // A retry after a partial failure must not send the customer a second copy.
  if (alreadySent('send_meta', messageId, row.message.deliveryStatus)) return;

  const meta = (row.message.meta ?? {}) as SendMeta;
  const platform = (meta.platform ?? row.conversation.channel) as MetaPlatform;

  if (platform !== 'facebook' && platform !== 'instagram') {
    throw new Error(`send_meta cannot deliver on "${platform}"`);
  }

  const sendKind = meta.sendKind ?? (await inferSendKind(row.conversation.id));
  const attempt: Attempt = { sendKind, tag: null, final: isFinalAttempt(job) };

  // Which host and credential this goes out with. Resolved once here so the log
  // line, the failure explanation and the request itself cannot disagree about
  // it — `endpoint()` in the client asks the same function.
  const connection = metaConnection(platform);

  // Who this message is from, in the only terms Meta's tagging cares about.
  // Read off the row rather than passed in the payload: `HUMAN_AGENT` is a claim
  // that a person wrote this, and the column recording that person is the only
  // thing that can substantiate it. A flag on the job would be a second copy of
  // the fact, set by whichever caller remembered to.
  const author: MetaSendAuthor = row.message.authorAgentId ? 'human' : 'automated';

  try {
    const externalId = await deliver(sendKind, platform, row, meta, author, connection, attempt);

    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: externalId,
        deliveryError: null,
      })
      .where(eq(messages.id, messageId));

    log.info(`${messageId} sent as ${attempt.sendKind} on ${platform} via ${connection}`);
  } catch (error) {
    const message = errorMessage(error);

    // Meta answers a refused send with a sentence that names no rule — most of
    // the time "An unknown error has occurred." — so what the timeline shows is
    // that sentence plus what we know about the send it was refusing.
    const explained =
      error instanceof MetaApiError
        ? explainMetaSendError(error, {
            platform,
            connection,
            sendKind: explainedKind(attempt.sendKind),
            tag: attempt.tag,
          })
        : message;

    await db
      .update(messages)
      .set({ deliveryStatus: 'failed', deliveryError: explained.slice(0, 2000) })
      .where(eq(messages.id, messageId));

    // A permanent failure is not worth four more attempts: the agent needs to
    // know now, and the failed badge on the timeline is how they find out.
    if (error instanceof MetaApiError && !error.isTransient) {
      log.error(`${messageId} failed permanently: ${message}`);
      return;
    }

    throw error;
  }
}

type Row = {
  message: typeof messages.$inferSelect;
  conversation: typeof conversations.$inferSelect;
};

async function deliver(
  sendKind: SendKind,
  platform: MetaPlatform,
  row: Row,
  meta: SendMeta,
  author: MetaSendAuthor,
  connection: MetaConnection,
  attempt: Attempt,
): Promise<string | null> {
  const text = row.message.bodyText;

  if (sendKind === 'comment_reply') {
    // The root of the thread on Instagram, the comment itself on Facebook: an
    // Instagram reply hangs off the top-level comment and nowhere else, so once
    // a customer has answered inside a thread, replying to what they just wrote
    // means posting to a `replies` edge that does not exist.
    const commentId = commentReplyTarget({
      platform,
      externalId: row.conversation.externalId,
      lastCommentId: meta.commentId ?? (await lastInboundCommentId(row.conversation.id)),
    });
    if (!commentId) throw new Error('no comment to reply to on this ticket');
    return replyToComment({ platform, commentId, message: text });
  }

  if (sendKind === 'private_reply') {
    // The comment the agent is answering, not the thread's root: the seven days
    // a private reply is allowed within are counted from the comment it names.
    const commentId = meta.commentId ?? (await lastInboundCommentId(row.conversation.id));
    if (!commentId) throw new Error('no comment to reply privately to');

    // Meta allows exactly one private reply per comment, ever. A second attempt
    // is rejected, so this is the one send in the product that must not be
    // retried blindly — the error is recorded and the agent decides.
    return privateReplyToComment({ platform, commentId, message: text });
  }

  const target = await metaReplyTarget(row.conversation.id, platform);

  const recipientId = meta.recipientId ?? target.recipientId;
  if (!recipientId) throw new Error('no recipient id on this ticket');

  // Whether the thread is answerable at all, before whether there is time left
  // to answer it: an inbox another app owns, or a page this deployment cannot
  // address, stays refused however fresh the customer's message is. Graph
  // answers both with "An unknown error has occurred." and an HTTP 500, which
  // is retried three times and explains nothing — so the send is stopped here
  // instead, where the reason is known.
  //
  // Re-checked here as well as in the console for the same reason the window
  // is: thread control can be handed to another tool between an agent writing
  // and this job running.
  if (!target.thread.canSend) {
    throw new MetaSendRefusal(target.thread.explanation ?? 'This thread cannot be answered.');
  }

  const window = metaWindowState(row.conversation.lastCustomerMessageAt);

  if (sendKind === 'feedback_template') {
    return deliverFeedbackCard(row, meta, recipientId, window, connection, attempt);
  }

  const tag = messagingTag(window, author);
  attempt.tag = tag;

  if (!tag) {
    // Two ways to arrive here, and they are not the same failure. The seven days
    // lapsing is about the customer, and is checked here as well as in the
    // console because they can lapse between an agent writing and this job
    // running. An automated message past 24 hours is about us: the only thing
    // that would carry it is `HUMAN_AGENT`, and nothing wrote it by hand — see
    // `MetaSendAuthor`. Refused rather than sent untagged, which Graph would
    // reject anyway, and refused permanently, because no retry makes a rule the
    // author.
    throw new MetaSendRefusal(
      window.needsHumanAgentTag
        ? 'An automated reply cannot go out more than 24 hours after the customer wrote: ' +
            'past that only the HUMAN_AGENT tag sends, and it may only be used for a message ' +
            'a person actually wrote.'
        : 'The 7-day messaging window has closed; only the customer can reopen this conversation.',
    );
  }

  if (sendKind === 'quick_reply_survey') {
    return sendQuickReplySurvey(platform, recipientId, row, meta);
  }

  const result = await sendDirectMessage({ platform, recipientId, text, tag });
  return result.messageId;
}

/**
 * Messenger's feedback card, and what happens when Graph will not take it.
 *
 * Meta marks the card "in development" and may withdraw it, and the day it
 * does is a permanent refusal on every Facebook survey. So a permanent
 * refusal is kept on the settings row, where the admin page prints it — a
 * worker log line is where §6.27's missing approval hid for a month — and,
 * while the 24 hours are open, the survey goes as quick replies on the same
 * row instead. Past them nothing else sends, and the row fails with Graph's
 * own sentence, as any refused send does.
 *
 * Only a refusal of *the card* falls back. A transient answer is the queue's
 * to retry as the card — until the queue's last try, where one that names
 * nothing (`isUnspecified`: codes 1 and 2, a bare 5xx) counts as the card
 * refused: "An unknown error has occurred" is the shape Graph gives most
 * refusals, and a card withdrawn that way would otherwise be retried to
 * `dead` on every Facebook survey, with no warning on the page and the 24
 * hours spent. A rate limit that outlasts the retries is not, and goes to
 * `dead` as any send's would. A dead
 * token, a refusal this app made itself, and a refusal about the recipient —
 * a customer who blocked the Page, a thread another app holds
 * (`isRecipientRefusal`) — would refuse anything sent here: kept on the
 * settings row, the admin page would read a blocked customer as Meta
 * withdrawing the card, and the buttons sent in its place would be refused
 * the same way. Those fail the row as any refused send does. A card that does
 * go out clears the last refusal, so the page's warning means "refusing now"
 * and not "refused once".
 */
async function deliverFeedbackCard(
  row: Row,
  meta: SendMeta,
  recipientId: string,
  window: MetaWindowState,
  connection: MetaConnection,
  attempt: Attempt,
): Promise<string | null> {
  if (row.conversation.channel !== 'facebook') {
    throw new MetaSendRefusal('Messenger’s feedback card can only be sent on Facebook.');
  }
  if (!meta.csatSurveyId || !meta.card) {
    throw new MetaSendRefusal('This survey message carries no feedback card to send.');
  }

  // The card's own tag, never `HUMAN_AGENT`: nobody wrote it.
  const tag = feedbackTemplateTag(window);
  attempt.tag = tag;
  if (!tag) {
    throw new MetaSendRefusal(
      'Seven days have passed since the customer last wrote, and past them not even ' +
        'the feedback card sends; only the customer can reopen this conversation.',
    );
  }

  let result;
  try {
    result = await sendMessageRequest(
      'facebook',
      feedbackTemplateRequest({ recipientId, surveyId: meta.csatSurveyId, card: meta.card, tag }),
    );
  } catch (error) {
    if (
      !(error instanceof MetaApiError) ||
      error instanceof MetaSendRefusal ||
      (error.isTransient && !(attempt.final && isUnspecified(error))) ||
      error.status === 0 ||
      error.code === ACCESS_TOKEN_CODE ||
      isRecipientRefusal(error, tag)
    ) {
      throw error;
    }

    await recordTemplateRefusal(
      explainMetaSendError(error, {
        platform: 'facebook',
        connection,
        sendKind: 'feedback_card',
        tag,
      }),
    );

    if (!window.isOpen || !meta.labels) throw error;

    // Switched on the row before the send, so a retry after a failure from
    // here on goes straight to the quick replies instead of asking for the
    // card again and writing a second refusal.
    await fallBackToQuickReplies(meta.csatSurveyId, row.message.id);
    attempt.sendKind = 'quick_reply_survey';
    attempt.tag = 'RESPONSE';
    log.warn(
      `${row.message.id}: Messenger refused the feedback card, sending quick replies`,
      error,
    );

    return sendQuickReplySurvey('facebook', recipientId, row, meta);
  }

  // Outside the send's `try`, and swallowed: the card has gone, and a failure
  // to take a stale warning down must neither send the buttons as well nor
  // fail the job, whose retry would send the customer a second card.
  try {
    await clearTemplateRefusal();
  } catch (error) {
    log.warn(`${row.message.id}: could not clear the last card refusal`, error);
  }
  return result.messageId;
}

async function sendQuickReplySurvey(
  platform: MetaPlatform,
  recipientId: string,
  row: Row,
  meta: SendMeta,
): Promise<string | null> {
  if (!meta.csatSurveyId || !meta.labels) {
    throw new MetaSendRefusal('This survey message carries no rating buttons to send.');
  }

  const result = await sendMessageRequest(
    platform,
    quickReplySurveyRequest({
      platform,
      recipientId,
      surveyId: meta.csatSurveyId,
      text: row.message.bodyText,
      labels: meta.labels,
    }),
  );
  return result.messageId;
}

/**
 * What `explainMetaSendError` explains a failure as: the survey's quick
 * replies as the direct message they are, the card as itself.
 */
function explainedKind(sendKind: SendKind): MetaSendContext['sendKind'] {
  switch (sendKind) {
    case 'feedback_template':
      return 'feedback_card';
    case 'quick_reply_survey':
      return 'dm';
    default:
      return sendKind;
  }
}

/**
 * What kind of send this ticket takes, for rows written before the console
 * started recording it.
 *
 * A ticket whose inbound history is comments is answered with a comment; one
 * whose history is messages is answered with a message.
 */
async function inferSendKind(
  conversationId: string,
): Promise<'dm' | 'comment_reply' | 'private_reply'> {
  const commentId = await lastInboundCommentId(conversationId);
  return commentId ? 'comment_reply' : 'dm';
}

async function lastInboundCommentId(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ meta: messages.meta, channelMessageId: messages.channelMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        ne(messages.channelMessageId, ''),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(10);

  for (const row of rows) {
    const meta = (row.meta ?? {}) as { metaKind?: string; commentId?: string };
    if (meta.metaKind === 'comment') return meta.commentId ?? row.channelMessageId;
  }

  return null;
}
