import { and, desc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import {
  MetaApiError,
  privateReplyToComment,
  replyToComment,
  sendDirectMessage,
} from '@/lib/meta/client';
import { commentReplyTarget } from '@/lib/meta/comments';
import { metaConnection } from '@/lib/meta/connection';
import { explainMetaSendError, MetaSendRefusal } from '@/lib/meta/errors';
import type { MetaPlatform } from '@/lib/meta/types';
import { messagingTag, metaWindowState, type MetaSendAuthor } from '@/lib/meta/window';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { alreadySent } from './already-sent';
import { subjectGone } from './subject-gone';
import { metaReplyTarget } from '@/lib/tickets/meta-thread';
import { errorMessage } from '@/lib/errors';

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
 * The console writes the message row first and enqueues this, so the agent sees
 * their reply immediately and a Meta outage delays delivery rather than losing
 * what they wrote.
 */

type SendMeta = {
  metaKind?: 'direct_message' | 'comment';
  sendKind?: 'dm' | 'comment_reply' | 'private_reply';
  platform?: MetaPlatform;
  commentId?: string;
  /** The customer's page-scoped id, for a DM. */
  recipientId?: string;
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
    const externalId = await deliver(sendKind, platform, row, meta, author);

    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: externalId,
        deliveryError: null,
      })
      .where(eq(messages.id, messageId));

    console.log(`[send_meta] ${messageId} sent as ${sendKind} on ${platform} via ${connection}`);
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
            sendKind,
            tag:
              sendKind === 'dm'
                ? messagingTag(metaWindowState(row.conversation.lastCustomerMessageAt), author)
                : null,
          })
        : message;

    await db
      .update(messages)
      .set({ deliveryStatus: 'failed', deliveryError: explained.slice(0, 2000) })
      .where(eq(messages.id, messageId));

    // A permanent failure is not worth four more attempts: the agent needs to
    // know now, and the failed badge on the timeline is how they find out.
    if (error instanceof MetaApiError && !error.isTransient) {
      console.error(`[send_meta] ${messageId} failed permanently: ${message}`);
      return;
    }

    throw error;
  }
}

async function deliver(
  sendKind: 'dm' | 'comment_reply' | 'private_reply',
  platform: MetaPlatform,
  row: { message: typeof messages.$inferSelect; conversation: typeof conversations.$inferSelect },
  meta: SendMeta,
  author: MetaSendAuthor,
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
  const tag = messagingTag(window, author);

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

  const result = await sendDirectMessage({ platform, recipientId, text, tag });
  return result.messageId;
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
