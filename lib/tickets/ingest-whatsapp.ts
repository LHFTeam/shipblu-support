import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import { explainDeliveryError } from '@/lib/whatsapp/errors';
import type {
  NormalisedEcho,
  NormalisedInboundMessage,
  NormalisedStatus,
} from '@/lib/whatsapp/types';
import { windowState } from '@/lib/whatsapp/window';
import { isReadOnlyChannel } from './channel-policy';
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

  const channel = await resolveWhatsAppChannel(message.phoneNumberId);
  const existing = await findLiveConversation(contactId, channel.kind);

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
          channel: channel.kind,
          channelId: channel.id,
          statusId,
          // WhatsApp has no subject line. Seeding it from the first message
          // keeps the ticket list scannable instead of a column of "WhatsApp".
          subject: subjectFrom(message.text),
          requesterContactId: contactId,
          groupId: channel.defaultGroupId,
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

  // Linking runs whatever the channel, deliberately outside the guard below.
  // A bot transcript is not a ticket the team works — which is why the SLA and
  // automations stay out of it — but it is full of tracking numbers, and it is
  // exactly what a "conversations for this shipment" query should find.
  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: message.text,
    kind: 'reply',
  });

  // Deliberately not run for a read-only channel. Everything downstream assumes
  // a ticket the team is working: the SLA would start a first-response clock
  // nobody is allowed to stop, the sweep would raise breaches every five
  // minutes for the rest of time, automations could assign it to a person who
  // cannot answer it, and CSAT would ask the customer to rate a conversation
  // they had with a bot.
  if (!isReadOnlyChannel(channel.kind)) {
    await afterInboundMessage(result.conversationId, result.createdConversation, message.sentAt);
  }

  return { ...result, duplicate: false };
}

/**
 * A message the bot sent, mirrored onto the conversation it belongs to.
 *
 * Filed as outbound with no author, because nobody here wrote it — the timeline
 * labels it as the bot. It can arrive before any inbound message, since the bot
 * often opens the conversation, so this creates the conversation when needed
 * rather than assuming one exists.
 */
export type WhatsAppEchoResult = {
  conversationId: string | null;
  conversationNumber: number;
  messageId: string | null;
  createdConversation: boolean;
  duplicate: boolean;
  /** True when the echo was for a channel we do not mirror. */
  ignored: boolean;
};

const IGNORED: WhatsAppEchoResult = {
  conversationId: null,
  conversationNumber: 0,
  messageId: null,
  createdConversation: false,
  duplicate: false,
  ignored: true,
};

export async function ingestWhatsAppEcho(echo: NormalisedEcho): Promise<WhatsAppEchoResult> {
  const channel = await resolveWhatsAppChannel(echo.phoneNumberId);

  // An echo from the support number is our own outbound message coming back. We
  // already wrote that row when we sent it, and the delivery status webhook
  // maintains it, so there is nothing to add. Mirroring it would double every
  // reply the team sends.
  if (!isReadOnlyChannel(channel.kind)) return IGNORED;

  const seen = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.channelMessageId, echo.wamid))
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
      ignored: false,
    };
  }

  // The identity is still a WhatsApp one: it is the same person and the same
  // phone number whichever of our numbers they wrote to, so they resolve to one
  // contact and both conversations show on their record.
  const { contactId } = await resolveContact({ channel: 'whatsapp', identifier: echo.to });

  const existing = await findLiveConversation(contactId, channel.kind);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;
    } else {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: channel.kind,
          channelId: channel.id,
          statusId,
          subject: subjectFrom(echo.text),
          requesterContactId: contactId,
          groupId: channel.defaultGroupId,
          lastMessageAt: echo.sentAt,
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
        direction: 'outbound',
        kind: 'reply',
        // No author on either side: no agent wrote it and the customer did not
        // send it. The channel is what tells the timeline to label it as the bot.
        bodyText: echo.text,
        bodyHtml: null,
        rawBody: JSON.stringify(echo.raw),
        channelMessageId: echo.wamid,
        inReplyTo: echo.replyToWamid,
        fromAddress: echo.from,
        toAddresses: [echo.to],
        // Meta only echoes what it accepted for delivery, and no status webhook
        // will follow for a message another service sent, so 'sent' is as much
        // as can honestly be claimed.
        deliveryStatus: 'sent',
        meta: {
          whatsappType: echo.type,
          phoneNumberId: echo.phoneNumberId,
          echo: true,
          ...(echo.creationType ? { creationType: echo.creationType } : {}),
          ...(echo.media
            ? {
                media: {
                  mediaId: echo.media.mediaId,
                  mimeType: echo.media.mimeType,
                  filename: echo.media.filename,
                  isVoice: echo.media.isVoice,
                  downloaded: false,
                },
              }
            : {}),
        },
        createdAt: echo.sentAt,
      })
      .returning({ id: messages.id });

    // lastCustomerMessageAt is deliberately untouched: the bot writing does not
    // open a 24-hour window for us, and this channel cannot be replied to
    // anyway.
    await tx
      .update(conversations)
      .set({ lastMessageAt: echo.sentAt })
      .where(eq(conversations.id, conversationId));

    return {
      conversationId,
      conversationNumber,
      messageId: insertedMessage[0]!.id,
      createdConversation,
    };
  });

  if (echo.media) {
    await enqueue(
      'download_media',
      { messageId: result.messageId, mediaId: echo.media.mediaId },
      { priority: 5, dedupeKey: `download_media:${echo.media.mediaId}` },
    );
  }

  // The bot's own half of the transcript carries tracking numbers too, and is
  // often the only half that does.
  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: echo.text,
    kind: 'reply',
  });

  return { ...result, duplicate: false, ignored: false };
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
async function findLiveConversation(
  contactId: string,
  channel: 'whatsapp' | 'whatsapp_bot',
): Promise<LiveConversation | null> {
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
        eq(conversations.channel, channel),
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

export type ResolvedChannel = {
  id: string | null;
  defaultGroupId: string | null;
  /** The conversation channel to file under — `whatsapp` or `whatsapp_bot`. */
  kind: 'whatsapp' | 'whatsapp_bot';
};

/**
 * Which of our numbers this event arrived on, and therefore what kind of
 * conversation it belongs to.
 *
 * Driven by the channels table rather than a constant, so another bot number is
 * a row an admin adds rather than a deploy. A number with no row at all falls
 * back to ordinary WhatsApp: the same behaviour as before this channel existed,
 * which is the right way to be wrong — a missing row must not turn the support
 * number into a read-only one and stop the team replying.
 */
export async function resolveWhatsAppChannel(
  phoneNumberId: string | null,
): Promise<ResolvedChannel> {
  const rows = await db
    .select({
      id: channels.id,
      type: channels.type,
      defaultGroupId: channels.defaultGroupId,
      config: channels.config,
    })
    .from(channels)
    .where(and(inArray(channels.type, ['whatsapp', 'whatsapp_bot']), eq(channels.isActive, true)));

  const byNumber = phoneNumberId
    ? rows.find((c) => c.config?.phoneNumberId === phoneNumberId)
    : undefined;

  if (byNumber) {
    return {
      id: byNumber.id,
      defaultGroupId: byNumber.defaultGroupId,
      kind: byNumber.type === 'whatsapp_bot' ? 'whatsapp_bot' : 'whatsapp',
    };
  }

  // No row for this number. Only ever the support channel — a bot number is
  // known by its row, and inferring "bot" from the absence of one would hide
  // real customer messages from the team.
  const support = rows.find((c) => c.type === 'whatsapp');
  return {
    id: support?.id ?? null,
    defaultGroupId: support?.defaultGroupId ?? null,
    kind: 'whatsapp',
  };
}

/** First line, trimmed to something that fits a ticket list. */
export function subjectFrom(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'WhatsApp conversation';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
