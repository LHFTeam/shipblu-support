import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { explainDeliveryError } from '@/lib/whatsapp/errors';
import type { NormalisedInboundMessage, NormalisedStatus } from '@/lib/whatsapp/types';
import { windowState } from '@/lib/whatsapp/window';
import { resolveContact } from './contacts';

/**
 * Inbound WhatsApp → conversation.
 *
 * The email pipeline threads on Message-ID; WhatsApp has no equivalent, so the
 * thread *is* the customer. A new message continues that customer's live
 * WhatsApp conversation, which is what makes the console read like Freshchat
 * rather than opening a fresh ticket per message.
 */

export type WhatsAppIngestResult = {
  conversationId: string;
  conversationNumber: number;
  messageId: string;
  createdConversation: boolean;
  duplicate: boolean;
};

export async function ingestWhatsAppMessage(
  message: NormalisedInboundMessage,
): Promise<WhatsAppIngestResult> {
  // Idempotency: Meta redelivers the whole batch on any non-200, and a stored
  // payload can be replayed by hand, so the same wamid must never appear twice.
  const seen = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.channelMessageId, message.wamid))
    .limit(1);

  if (seen[0]) {
    const existing = await db
      .select({ number: conversations.number })
      .from(conversations)
      .where(eq(conversations.id, seen[0].conversationId))
      .limit(1);

    return {
      conversationId: seen[0].conversationId,
      conversationNumber: existing[0]?.number ?? 0,
      messageId: seen[0].id,
      createdConversation: false,
      duplicate: true,
    };
  }

  const { contactId } = await resolveContact({
    channel: 'whatsapp',
    identifier: message.from,
    displayName: message.profileName,
  });

  const channel = await whatsappChannel(message.phoneNumberId);
  const existing = await findLiveConversation(contactId);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;

      if (existing.statusCategory === 'resolved') {
        const reopenTo = await defaultOpenStatusId(tx);
        if (reopenTo) {
          await tx
            .update(conversations)
            .set({
              statusId: reopenTo,
              resolvedAt: null,
              reopenCount: existing.reopenCount + 1,
            })
            .where(eq(conversations.id, conversationId));

          await tx.insert(conversationEvents).values({
            conversationId,
            type: 'reopened',
            actorLabel: 'inbound_whatsapp',
            data: { reason: 'customer_replied' },
          });
        }
      }
    } else {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: 'whatsapp',
          channelId: channel?.id ?? null,
          statusId,
          // WhatsApp has no subject line. Seeding it from the first message
          // keeps the ticket list scannable instead of a column of "WhatsApp".
          subject: subjectFrom(message.text),
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
        // No HTML on WhatsApp; the console renders bodyText and applies
        // WhatsApp's own *bold* / _italic_ markup at display time.
        bodyHtml: null,
        rawBody: JSON.stringify(message.raw),
        channelMessageId: message.wamid,
        inReplyTo: message.replyToWamid,
        fromAddress: message.from,
        deliveryStatus: 'delivered',
        deliveredAt: message.sentAt,
        meta: {
          whatsappType: message.type,
          profileName: message.profileName,
          phoneNumberId: message.phoneNumberId,
          ...(message.media
            ? {
                media: {
                  mediaId: message.media.mediaId,
                  mimeType: message.media.mimeType,
                  filename: message.media.filename,
                  isVoice: message.media.isVoice,
                  // Flipped to true by the download_media job. Until then the
                  // console shows the placeholder rather than a broken link.
                  downloaded: false,
                },
              }
            : {}),
        },
        createdAt: message.sentAt,
      })
      .returning({ id: messages.id });

    const messageId = insertedMessage[0]!.id;

    // lastCustomerMessageAt is what opens the 24-hour window, so it must be the
    // customer's timestamp from Meta, not now(): a delayed webhook would
    // otherwise hand us hours of window we do not actually have.
    await tx
      .update(conversations)
      .set({ lastMessageAt: message.sentAt, lastCustomerMessageAt: message.sentAt })
      .where(eq(conversations.id, conversationId));

    return { conversationId, conversationNumber, messageId, createdConversation };
  });

  // Meta's media URLs expire in about five minutes, so the download is queued
  // immediately and at high priority rather than fetched when an agent opens
  // the ticket — by then the file would be unrecoverable.
  if (message.media) {
    await enqueue(
      'download_media',
      { messageId: result.messageId, mediaId: message.media.mediaId },
      { priority: 5, dedupeKey: `download_media:${message.media.mediaId}` },
    );
  }

  return { ...result, duplicate: false };
}

/**
 * Applies a delivery status webhook to the outbound message it refers to.
 *
 * Statuses arrive out of order — `read` can land before `delivered` — so the
 * status only ever moves forward through sent → delivered → read. `failed` wins
 * from anywhere, because an agent must see that a message did not arrive.
 */
const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

export async function applyWhatsAppStatus(status: NormalisedStatus): Promise<boolean> {
  const rows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      deliveryStatus: messages.deliveryStatus,
      meta: messages.meta,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.channelMessageId, status.wamid))
    .limit(1);

  const message = rows[0];
  // A status for a message we never sent: normal right after a migration, or
  // when another tool shares the number. Nothing to do.
  if (!message) return false;

  if (status.status === 'failed') {
    // Meta's own wording for 131047 contradicts a window we can see is open,
    // so the stored error explains the real cause rather than repeating it.
    const explained = await explainFailure(message, status);

    await db
      .update(messages)
      .set({
        deliveryStatus: 'failed',
        deliveryError: explained,
        meta: { ...(message.meta as Record<string, unknown>), failedAt: status.at.toISOString() },
      })
      .where(eq(messages.id, message.id));
    return true;
  }

  if (message.deliveryStatus === 'failed') return false;

  const current = STATUS_RANK[message.deliveryStatus] ?? 0;
  const incoming = STATUS_RANK[status.status] ?? 0;
  if (incoming <= current) return false;

  await db
    .update(messages)
    .set({
      deliveryStatus: status.status,
      ...(status.status === 'delivered' ? { deliveredAt: status.at } : {}),
      ...(status.status === 'read' ? { readAt: status.at } : {}),
    })
    .where(eq(messages.id, message.id));

  return true;
}

/**
 * Builds the stored failure text, comparing the number the reply went out from
 * against the number the conversation arrived on.
 */
async function explainFailure(
  message: {
    conversationId: string;
    meta: unknown;
    lastCustomerMessageAt: Date | null;
  },
  status: NormalisedStatus,
): Promise<string | null> {
  if (!status.error) return null;

  const code = Number(status.error.split(':')[0]);
  const sentFrom = (message.meta as { phoneNumberId?: unknown }).phoneNumberId;

  const inbound = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(
      and(eq(messages.conversationId, message.conversationId), eq(messages.direction, 'inbound')),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  const arrivedOn = (inbound[0]?.meta as { phoneNumberId?: unknown } | undefined)?.phoneNumberId;

  return explainDeliveryError(Number.isFinite(code) ? code : null, status.error, {
    windowOpen: windowState(message.lastCustomerMessageAt, status.at).isOpen,
    inboundPhoneNumberId: typeof arrivedOn === 'string' ? arrivedOn : null,
    sentFromPhoneNumberId: typeof sentFrom === 'string' ? sentFrom : null,
  });
}

type LiveConversation = {
  id: string;
  number: number;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  reopenCount: number;
};

/**
 * The customer's current WhatsApp conversation, if any.
 *
 * A closed conversation is deliberately *not* continued: closing is the team's
 * signal that the matter is finished, and reopening it weeks later would bury
 * the new question under old history. Resolved is different — that is a
 * pending-confirmation state, so a reply reopens it.
 */
async function findLiveConversation(contactId: string): Promise<LiveConversation | null> {
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
        eq(conversations.channel, 'whatsapp'),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.statusCategory === 'closed') return null;
  return row;
}

async function defaultOpenStatusId(tx: typeof db): Promise<string | null> {
  const rows = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.category, 'open'), eq(ticketStatuses.isDefault, true)))
    .limit(1);

  if (rows[0]) return rows[0].id;

  const fallback = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, 'open'))
    .orderBy(ticketStatuses.position)
    .limit(1);

  return fallback[0]?.id ?? null;
}

/** Matches the configured number when we can, else any active WhatsApp channel. */
async function whatsappChannel(phoneNumberId: string | null) {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId, config: channels.config })
    .from(channels)
    .where(and(eq(channels.type, 'whatsapp'), eq(channels.isActive, true)));

  if (rows.length === 0) return null;
  if (!phoneNumberId) return rows[0]!;

  return rows.find((c) => c.config?.phoneNumberId === phoneNumberId) ?? rows[0]!;
}

/** First line, trimmed to something that fits a ticket list. */
export function subjectFrom(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'WhatsApp conversation';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
