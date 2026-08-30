import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import type {
  MetaPlatform,
  NormalisedComment,
  NormalisedDirectMessage,
  NormalisedReceipt,
} from '@/lib/meta/types';
import { enqueue } from '@/lib/queue';
import { needsChannelProfile, resolveContact } from './contacts';
import { afterInboundMessage, afterMessageStored } from './lifecycle';

/**
 * Inbound Facebook and Instagram → conversations.
 *
 * Two threading rules, because the two kinds of event are not the same thing:
 *
 * - A **direct message** threads on the customer, exactly like WhatsApp. One
 *   live conversation per person per platform, so the console reads as a chat
 *   rather than as a ticket per message.
 *
 * - A **comment** threads on the comment it belongs to. One ticket per
 *   top-level comment and its replies, keyed on the root comment id, so a
 *   customer who comments on two posts gets two tickets — which is right,
 *   because they are two conversations about two things, in public, and each
 *   needs its own public answer.
 */

export type MetaIngestResult = {
  conversationId: string;
  conversationNumber: number;
  messageId: string;
  createdConversation: boolean;
  duplicate: boolean;
};

const PLATFORM_LABEL: Record<MetaPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};

// --- Direct messages --------------------------------------------------------

export async function ingestMetaMessage(
  message: NormalisedDirectMessage,
): Promise<MetaIngestResult> {
  const existingMessage = await findByChannelMessageId(message.mid);
  if (existingMessage) return existingMessage;

  const { contactId } = await resolveContact({
    channel: message.platform,
    identifier: message.from,
    displayName: message.senderName,
  });

  // Messenger and Instagram identify the sender by a scoped id and nothing else,
  // so unless the profile is looked up this ticket is filed under a 17-digit
  // number. Queued before the ticket is written rather than after, because the
  // name is wanted on the first render.
  if (await needsChannelProfile(message.platform, message.from)) {
    await queueProfileLookup(message.platform, contactId, message.from);
  }

  const channel = await channelFor(message.platform);
  const existing = await findLiveConversation(contactId, message.platform);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;

      if (existing.statusCategory === 'resolved') {
        await reopen(tx, conversationId, existing.reopenCount, `inbound_${message.platform}`);
      }
    } else {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: message.platform,
          channelId: channel?.id ?? null,
          statusId,
          // Neither platform has a subject. The first message is what makes the
          // ticket list scannable instead of a column of "Instagram".
          subject: subjectFrom(message.text, PLATFORM_LABEL[message.platform]),
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          lastMessageAt: message.sentAt,
          lastCustomerMessageAt: message.sentAt,
        })
        .returning({ id: conversations.id, number: conversations.number });

      conversationId = inserted[0]!.id;
      conversationNumber = inserted[0]!.number;
      createdConversation = true;
    }

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: message.text,
        bodyHtml: null,
        rawBody: JSON.stringify(message.raw),
        channelMessageId: message.mid,
        inReplyTo: message.replyToMid,
        fromAddress: message.from,
        deliveryStatus: 'delivered',
        deliveredAt: message.sentAt,
        meta: {
          metaKind: 'direct_message',
          platform: message.platform,
          accountId: message.accountId,
          // Which of the two Meta connections delivered this. Recorded beside
          // `standby` rather than instead of it, because it is what makes the
          // flag readable: handover belongs to the Facebook Page, so a standby
          // reported by the Page connection says nothing about a reply sent
          // with the Instagram account's own token.
          connection: message.connection,
          // Whether this app may answer the thread at all, recorded per message
          // because thread control moves: the same customer can be answerable
          // today and handed to another inbox tool tomorrow.
          standby: message.standby,
          attachments: message.attachments,
        },
        createdAt: message.sentAt,
      })
      .returning({ id: messages.id });

    await tx
      .update(conversations)
      .set({ lastMessageAt: message.sentAt, lastCustomerMessageAt: message.sentAt })
      .where(eq(conversations.id, conversationId));

    return {
      conversationId,
      conversationNumber,
      messageId: insertedMessage[0]!.id,
      createdConversation,
    };
  });

  await queueAttachments(result.messageId, message.attachments);

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: message.text,
    kind: 'reply',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, message.sentAt);

  return { ...result, duplicate: false };
}

// --- Comments ---------------------------------------------------------------

export async function ingestMetaComment(comment: NormalisedComment): Promise<MetaIngestResult> {
  const existingMessage = await findByChannelMessageId(comment.commentId);
  if (existingMessage) return existingMessage;

  const { contactId } = await resolveContact({
    channel: comment.platform,
    identifier: comment.from || `unknown:${comment.commentId}`,
    displayName: comment.fromName,
  });

  const channel = await channelFor(comment.platform);

  // The root of the thread is what the ticket is about. A reply to a comment
  // belongs on the same ticket as the comment it answers.
  const rootId = comment.parentCommentId ?? comment.commentId;
  const externalId = `${comment.platform}:comment:${rootId}`;

  const existing = await findByExternalId(externalId);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;

      if (existing.statusCategory === 'resolved') {
        await reopen(tx, conversationId, existing.reopenCount, `inbound_${comment.platform}`);
      }
    } else {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: comment.platform,
          channelId: channel?.id ?? null,
          statusId,
          subject: subjectFrom(comment.text, `${PLATFORM_LABEL[comment.platform]} comment`),
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          externalId,
          lastMessageAt: comment.createdAt,
          lastCustomerMessageAt: comment.createdAt,
        })
        .returning({ id: conversations.id, number: conversations.number });

      conversationId = inserted[0]!.id;
      conversationNumber = inserted[0]!.number;
      createdConversation = true;

      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'comment_thread_opened',
        actorLabel: `inbound_${comment.platform}`,
        data: { postId: comment.postId, rootCommentId: rootId },
      });
    }

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: comment.text || '[empty comment]',
        bodyHtml: null,
        rawBody: JSON.stringify(comment.raw),
        // The comment id is the idempotency key, and it is also what an agent's
        // public reply is posted against.
        channelMessageId: comment.commentId,
        inReplyTo: comment.parentCommentId,
        fromAddress: comment.from || null,
        deliveryStatus: 'delivered',
        deliveredAt: comment.createdAt,
        meta: {
          metaKind: 'comment',
          platform: comment.platform,
          connection: comment.connection,
          commentId: comment.commentId,
          parentCommentId: comment.parentCommentId,
          postId: comment.postId,
          isPublic: true,
        },
        createdAt: comment.createdAt,
      })
      .returning({ id: messages.id });

    await tx
      .update(conversations)
      .set({ lastMessageAt: comment.createdAt, lastCustomerMessageAt: comment.createdAt })
      .where(eq(conversations.id, conversationId));

    return {
      conversationId,
      conversationNumber,
      messageId: insertedMessage[0]!.id,
      createdConversation,
    };
  });

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: comment.text,
    kind: 'reply',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, comment.createdAt);

  return { ...result, duplicate: false };
}

// --- Receipts ---------------------------------------------------------------

/**
 * Applies a delivery or read receipt.
 *
 * Only ever moves forward through sent → delivered → read, because Meta sends
 * them out of order often enough that a naive write would show a message going
 * backwards from read to delivered.
 */
const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

export async function applyMetaReceipt(receipt: NormalisedReceipt): Promise<number> {
  if (receipt.mids.length === 0) return 0;

  let updated = 0;

  for (const mid of receipt.mids) {
    const rows = await db
      .select({ id: messages.id, deliveryStatus: messages.deliveryStatus })
      .from(messages)
      .where(eq(messages.channelMessageId, mid))
      .limit(1);

    const message = rows[0];
    if (!message) continue;

    const current = STATUS_RANK[message.deliveryStatus] ?? 0;
    const next = STATUS_RANK[receipt.kind] ?? 0;
    if (next <= current) continue;

    await db
      .update(messages)
      .set({
        deliveryStatus: receipt.kind,
        ...(receipt.kind === 'delivered' ? { deliveredAt: new Date() } : { readAt: new Date() }),
      })
      .where(eq(messages.id, message.id));

    updated += 1;
  }

  return updated;
}

// --- Shared -----------------------------------------------------------------

async function findByChannelMessageId(channelMessageId: string): Promise<MetaIngestResult | null> {
  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      number: conversations.number,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.channelMessageId, channelMessageId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    conversationId: row.conversationId,
    conversationNumber: row.number,
    messageId: row.messageId,
    createdConversation: false,
    duplicate: true,
  };
}

type FoundConversation = {
  id: string;
  number: number;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  reopenCount: number;
};

/** The customer's live thread on this platform, if they have one. */
async function findLiveConversation(
  contactId: string,
  platform: MetaPlatform,
): Promise<FoundConversation | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      statusCategory: ticketStatuses.category,
      reopenCount: conversations.reopenCount,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        eq(conversations.requesterContactId, contactId),
        eq(conversations.channel, platform),
        isNull(conversations.deletedAt),
        isNull(conversations.externalId),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  const row = rows[0];
  // A closed conversation is history: a new message starts a new ticket rather
  // than reopening something the team considered finished weeks ago.
  if (!row || row.statusCategory === 'closed') return null;
  return row;
}

async function findByExternalId(externalId: string): Promise<FoundConversation | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      statusCategory: ticketStatuses.category,
      reopenCount: conversations.reopenCount,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(eq(conversations.externalId, externalId), isNull(conversations.deletedAt)))
    .limit(1);

  return rows[0] ?? null;
}

async function reopen(
  tx: typeof db,
  conversationId: string,
  reopenCount: number,
  actorLabel: string,
): Promise<void> {
  const statusId = await defaultOpenStatusId(tx);
  if (!statusId) return;

  const reopened = await tx
    .update(conversations)
    .set({ statusId, resolvedAt: null, reopenCount: reopenCount + 1 })
    .where(eq(conversations.id, conversationId))
    .returning({ resolvedBy: conversations.resolvedByAgentId });

  await tx.insert(conversationEvents).values({
    conversationId,
    type: 'reopened',
    actorLabel,
    data: { reason: 'customer_replied', resolvedBy: reopened[0]?.resolvedBy ?? null },
  });
}

async function defaultOpenStatusId(tx: typeof db): Promise<string | null> {
  const preferred = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.category, 'open'), eq(ticketStatuses.isDefault, true)))
    .limit(1);

  if (preferred[0]) return preferred[0].id;

  const fallback = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, 'open'))
    .orderBy(ticketStatuses.position)
    .limit(1);

  return fallback[0]?.id ?? null;
}

async function channelFor(platform: MetaPlatform) {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(eq(channels.type, platform), eq(channels.isActive, true)))
    .limit(1);

  return rows[0] ?? null;
}

/** First line, trimmed to something that fits a ticket list. */
function subjectFrom(text: string, fallback: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Meta's attachment URLs expire, so they are copied into our own storage
 * immediately rather than when an agent opens the ticket.
 */
async function queueAttachments(
  messageId: string,
  attachments: { type: string; url: string | null }[],
): Promise<void> {
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.url) continue;

    await enqueue(
      'download_media',
      { messageId, url: attachment.url, index, source: 'meta' },
      { priority: 5, dedupeKey: `download_media:${messageId}:${index}` },
    );
  }
}

/**
 * Asks Meta who this person is, once per person.
 *
 * Direct messages only. A comment already arrives with a name on Facebook and a
 * handle on Instagram, so there is nothing to look up — and a comment author's
 * id is not the page-scoped id the User Profile API answers for, so asking
 * would produce a refusal indistinguishable from "this app is not approved",
 * which is the one signal here that has to stay trustworthy.
 *
 * **No dedupe key**, though one per person is the obvious choice and was the
 * first thing written here. `jobs_dedupe_idx` is a plain unique index over the
 * whole table, so a key is spent permanently rather than until its job finishes:
 * the first lookup for a customer would burn `fetch_meta_profile:facebook:<id>`
 * forever, and every later attempt — the customer writing in again, the backfill
 * run after App Review finally grants the feature — would silently collapse onto
 * a row that completed months ago and do nothing. A job that reached `dead` is
 * never cleaned up at all, so that person could never be looked up again.
 *
 * The guard is in the handler instead, where it can read what actually happened:
 * a second job for an identity already answered for returns immediately. That
 * costs a cheap indexed read per duplicate and keeps the recovery path working,
 * which is the trade worth making.
 */
async function queueProfileLookup(
  platform: MetaPlatform,
  contactId: string,
  userId: string,
): Promise<void> {
  await enqueue('fetch_meta_profile', { contactId, platform, userId }, { priority: 20 });
}
