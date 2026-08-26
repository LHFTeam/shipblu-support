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
import { explainMetaSendError } from '@/lib/meta/errors';
import type { MetaPlatform } from '@/lib/meta/types';
import { messagingTag, metaWindowState } from '@/lib/meta/window';
import type { ClaimedJob } from '@/lib/queue';
import { metaReplyTarget } from '@/lib/tickets/meta-thread';

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
  const messageId = job.payload.messageId;
  if (typeof messageId !== 'string') throw new Error('send_meta requires a messageId');

  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`message ${messageId} not found`);

  // A retry after a partial failure must not send the customer a second copy.
  if (row.message.deliveryStatus !== 'pending' && row.message.deliveryStatus !== 'failed') {
    console.log(`[send_meta] ${messageId} is ${row.message.deliveryStatus}, skipping`);
    return;
  }

  const meta = (row.message.meta ?? {}) as SendMeta;
  const platform = (meta.platform ?? row.conversation.channel) as MetaPlatform;

  if (platform !== 'facebook' && platform !== 'instagram') {
    throw new Error(`send_meta cannot deliver on "${platform}"`);
  }

  const sendKind = meta.sendKind ?? (await inferSendKind(row.conversation.id));

  try {
    const externalId = await deliver(sendKind, platform, row, meta);

    await db
      .update(messages)
      .set({
        deliveryStatus: 'sent',
        channelMessageId: externalId,
        deliveryError: null,
      })
      .where(eq(messages.id, messageId));

    console.log(`[send_meta] ${messageId} sent as ${sendKind} on ${platform}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Meta answers a refused send with a sentence that names no rule — most of
    // the time "An unknown error has occurred." — so what the timeline shows is
    // that sentence plus what we know about the send it was refusing.
    const explained =
      error instanceof MetaApiError
        ? explainMetaSendError(error, {
            platform,
            sendKind,
            tag:
              sendKind === 'dm'
                ? messagingTag(metaWindowState(row.conversation.lastCustomerMessageAt))
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
    throw new MetaApiError(
      target.thread.explanation ?? 'This thread cannot be answered.',
      0,
      null,
      null,
      false,
    );
  }

  const window = metaWindowState(row.conversation.lastCustomerMessageAt);
  const tag = messagingTag(window);

  if (!tag) {
    // Checked here as well as in the console, because the seven days can lapse
    // between an agent writing and the job running.
    throw new MetaApiError(
      'The 7-day messaging window has closed; only the customer can reopen this conversation.',
      400,
      null,
      null,
      false,
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
