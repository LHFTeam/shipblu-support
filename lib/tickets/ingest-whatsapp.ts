import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversations, messages } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { onAgentReply } from '@/lib/sla';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import {
  accountForPhoneNumberId,
  listAccounts,
  resolveCredentialSource,
  type WhatsAppAccount,
} from '@/lib/whatsapp/accounts';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import { lastInboundPhoneNumberId } from '@/lib/whatsapp/conversation';
import { ACCESS_TOKEN_CODE, explainDeliveryError, type TokenOrigin } from '@/lib/whatsapp/errors';
import type {
  NormalisedEcho,
  NormalisedInboundMessage,
  NormalisedReaction,
  NormalisedStatus,
} from '@/lib/whatsapp/types';
import { windowState } from '@/lib/whatsapp/window';
import { isReadOnlyChannel } from './channel-policy';
import { findContactByIdentity, resolveContact } from './contacts';
import { UNNAMED_SUBJECT } from './customer-text';
import { latest } from './latest';
import { findLiveConversation, findNewestConversation } from './live-conversation';
import { reopenResolved } from './reopen';
import { requireDefaultOpenStatusId, requireResolvedStatusId } from './statuses';

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
  const seen = await storedMessage(message.wamid);
  if (seen) return { ...seen, createdConversation: false, duplicate: true };

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
        await reopenResolved(
          tx,
          { id: conversationId, reopenCount: existing.reopenCount },
          { actorLabel: 'inbound_whatsapp', reason: 'customer_replied' },
        );
      }
    } else {
      const statusId = await requireDefaultOpenStatusId(tx);

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
      .values(inboundRow(conversationId, contactId, message))
      .returning({ id: messages.id });

    const messageId = insertedMessage[0]!.id;

    // lastCustomerMessageAt is what opens the 24-hour window, so it must be the
    // customer's timestamp from Meta, not now(): a delayed webhook would
    // otherwise hand us hours of window we do not actually have.
    //
    // Forward only (`latest`), as email's columns are: deliveries are processed
    // in no order (§6.77), and an older message processed after a newer one
    // would drag the window shut early, and leave `onAgentReply` comparing a
    // late phone reply against the wrong message.
    const [clocks] = await tx
      .update(conversations)
      .set({
        lastMessageAt: latest(conversations.lastMessageAt, message.sentAt),
        lastCustomerMessageAt: latest(conversations.lastCustomerMessageAt, message.sentAt),
      })
      .where(eq(conversations.id, conversationId))
      .returning({ lastCustomerMessageAt: conversations.lastCustomerMessageAt });

    return {
      conversationId,
      conversationNumber,
      messageId,
      createdConversation,
      customerWroteAt: clocks?.lastCustomerMessageAt ?? message.sentAt,
    };
  });
  const { customerWroteAt, ...stored } = result;

  // Meta's media URLs expire in about five minutes, so the download is queued
  // immediately and at high priority rather than fetched when an agent opens
  // the ticket — by then the file would be unrecoverable.
  if (message.media) {
    await enqueue(
      'download_media',
      { messageId: stored.messageId, mediaId: message.media.mediaId },
      { priority: 5, dedupeKey: `download_media:${message.media.mediaId}` },
    );
  }

  // Linking runs whatever the channel, deliberately outside the guard below.
  // A bot transcript is not a ticket the team works — which is why the SLA and
  // automations stay out of it — but it is full of tracking numbers, and it is
  // exactly what a "conversations for this shipment" query should find.
  await afterMessageStored({
    conversationId: stored.conversationId,
    messageId: stored.messageId,
    bodyText: message.text,
    kind: 'reply',
    direction: 'inbound',
  });

  // Deliberately not run for a read-only channel. Everything downstream assumes
  // a ticket the team is working: the SLA would start a first-response clock
  // nobody is allowed to stop, the sweep would raise breaches every five
  // minutes for the rest of time, automations could assign it to a person who
  // cannot answer it, and CSAT would ask the customer to rate a conversation
  // they had with a bot.
  //
  // The next-response clock counts from the customer's newest message on the
  // ticket, not from this one, for the reason the columns above move forward
  // only: an older message processed late would restart it from its own
  // earlier instant and pull back a due date the newer one had set.
  if (!isReadOnlyChannel(channel.kind)) {
    await afterInboundMessage(stored.conversationId, stored.createdConversation, customerWroteAt, {
      id: stored.messageId,
    });
  }

  return { ...stored, duplicate: false };
}

/** The row a customer's message is stored as — and their reaction, which is the same row. */
function inboundRow(
  conversationId: string,
  contactId: string,
  message: NormalisedInboundMessage,
): typeof messages.$inferInsert {
  return {
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
      // The pin as coordinates, so the console can offer a map link rather
      // than the digits inside body_text. Read back through
      // `readSharedLocation`, which validates rather than trusting this.
      ...(message.location ? { location: message.location } : {}),
    },
    createdAt: message.sentAt,
  };
}

/**
 * A message sent from one of our numbers by something other than this system,
 * mirrored onto the conversation it belongs to. Two senders do that:
 *
 * - **The customer bot**, on its read-only channel. Filed as outbound with no
 *   author, because nobody here wrote it — the timeline labels it as the bot.
 * - **The WhatsApp Business app**, on a support number connected through
 *   coexistence: a reply the business typed on the phone. That one counts as
 *   the team's reply — the business decided so — so it moves
 *   `lastAgentMessageAt` and stops the SLA's response clocks, as an agent's
 *   reply in the console does. It still has no author, because no agent here
 *   wrote it, and it never touches `lastCustomerMessageAt`, which opens the
 *   24-hour window and is the customer's alone. The timeline labels it as the
 *   Business app.
 *
 * Either can arrive before any inbound message, so this creates the
 * conversation when needed rather than assuming one exists — open for the bot,
 * and resolved for the Business app, whose message asks nothing of the team
 * until the customer answers it.
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

  // An echo from an ordinary support number is our own outbound message coming
  // back. We already wrote that row when we sent it, and the delivery status
  // webhook maintains it, so there is nothing to add. Mirroring it would double
  // every reply the team sends. A coexistence number is the exception: its
  // echoes are what the business typed on the phone, which nothing else wrote.
  const sender = echoSender(channel);
  if (!sender) return IGNORED;
  const fromBusinessApp = sender === 'business_app';

  const seen = await storedMessage(echo.wamid);
  if (seen) return { ...seen, createdConversation: false, duplicate: true, ignored: false };

  // Checked above, before any clock moves: a redelivered echo — or one of our
  // own Cloud API sends coming back, whose row already carries its wamid — is a
  // duplicate, and stopping the SLA clock a second time would be a lie about
  // when the reply happened.

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
      // The business writing first from the phone files a resolved
      // conversation, not an open one. Nothing is owed on it — the team's own
      // message never makes a ticket need attention, which is why an echo
      // never reopens one — and right after onboarding this is the common
      // case, because every customer whose only conversation is the import has
      // no live one. Open, each would sit in the queue holding nothing but the
      // business's reply. The customer answering reopens it through the
      // ordinary path (`reopenResolved`), at the moment something is owed.
      // `resolvedAt` stays null, as an import's does, so no rollup counts a
      // resolution nobody made, and no survey is scheduled. The bot's channel
      // keeps opening, as it always has: it is read-only, and nothing queues on
      // it.
      const statusId = fromBusinessApp
        ? await requireResolvedStatusId(tx)
        : await requireDefaultOpenStatusId(tx);

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
          ...(fromBusinessApp ? { lastAgentMessageAt: echo.sentAt } : {}),
        })
        .returning({ id: conversations.id, number: conversations.number });

      conversationId = inserted[0]!.id;
      conversationNumber = inserted[0]!.number;
      createdConversation = true;
    }

    const insertedMessage = await tx
      .insert(messages)
      .values(echoRow(conversationId, echo, fromBusinessApp))
      .returning({ id: messages.id });

    // lastCustomerMessageAt is deliberately untouched: neither the bot nor the
    // business writing opens a 24-hour window for us. The business's reply
    // moves the team's column, forward only (`latest`): echoes arrive in no
    // guaranteed order, and an older one must not make the ticket read as
    // answered earlier than it was.
    await tx
      .update(conversations)
      .set(
        fromBusinessApp
          ? {
              lastMessageAt: latest(conversations.lastMessageAt, echo.sentAt),
              lastAgentMessageAt: latest(conversations.lastAgentMessageAt, echo.sentAt),
            }
          : { lastMessageAt: echo.sentAt },
      )
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

  // The business answered: the response clocks stop, at the moment it did —
  // and only for what came before it. An echo processed after a newer customer
  // message did not answer that message, and `onAgentReply` leaves its clock
  // running. After the transaction, as `storeAgentReply` does, so a failure
  // here is a logged SLA write and never a lost message.
  if (fromBusinessApp) await onAgentReply(result.conversationId, echo.sentAt);

  // The bot's own half of the transcript carries tracking numbers too, and is
  // often the only half that does.
  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: echo.text,
    kind: 'reply',
    direction: 'outbound',
  });

  return { ...result, duplicate: false, ignored: false };
}

/**
 * Who wrote an echo, judged by the number it came back on — or null for one
 * that is our own send coming back, which is not mirrored (`ingestWhatsAppEcho`
 * says why).
 */
function echoSender(channel: ResolvedChannel): 'bot' | 'business_app' | null {
  if (isReadOnlyChannel(channel.kind)) return 'bot';
  return channel.coexistence ? 'business_app' : null;
}

/** The row an echo is stored as — and the business's reaction, which is the same row. */
function echoRow(
  conversationId: string,
  echo: NormalisedEcho,
  fromBusinessApp: boolean,
): typeof messages.$inferInsert {
  return {
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
      // Who sent it, for the timeline's label: the bot's echoes predate
      // this field and are read as the bot when it is absent.
      ...(fromBusinessApp ? { echoSource: 'business_app' } : {}),
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
      // The bot sends pins too — a hub address, a pickup point — and an
      // agent reading the transcript needs to see where it pointed.
      ...(echo.location ? { location: echo.location } : {}),
    },
    createdAt: echo.sentAt,
  };
}

/**
 * A reaction, from the customer or from our side of the chat: stored, and
 * nothing else.
 *
 * Stored as the row its message or echo would have been — `meta.whatsappType`
 * and the whole delivery in `raw_body`, naming the reacted-to message as
 * `reaction.message_id` — so that the timeline can pair it with that message
 * from rows it already reads, with no backfill. The conversation it is filed on
 * is not otherwise touched.
 *
 * The first two decisions are the ones `applyMetaInteraction` makes for a
 * Facebook or Instagram reaction, for the same reasons. The third is this
 * path's own, and so is keeping a row at all: that function writes no row and
 * files only on a live conversation. Here the row is what lets the timeline
 * pair the reaction with its message, and a row on a closed ticket changes
 * nothing about it.
 *
 * **It moves no clock.** Not `last_customer_message_at`, which is the 24-hour
 * window and the next-response target — a customer answering our reply with 🙏
 * has been served, not left waiting, and measuring an agent as late for not
 * answering it is the worse error. Not the team's either: a ❤️ from the phone
 * stopping the response clocks would record an answer nobody wrote. And not
 * `last_message_at`, which orders the inbox and picks a customer's live
 * conversation: a thumbs-up floating a finished ticket to the top of the queue
 * asks for attention it does not need.
 *
 * **It reopens nothing and creates nothing.** A resolved ticket stays resolved,
 * and nothing downstream of a message runs — no SLA, automation, assignment,
 * out-of-hours reply, categorisation, priority classification or shipment
 * linking, none of which has anything to read in a 👍. With no conversation to
 * file it on — the person has no conversation on this channel, or the newest
 * one is a copied history — it is not stored at all, and no contact is made
 * for it: a ticket whose only content is a reaction is one nobody can answer.
 *
 * **It goes on the person's newest conversation, closed or not.** A reaction is
 * nearly always to something recent, which is on that ticket, and filing it there
 * changes nothing about it — the reason a message does not continue a closed
 * ticket is that it would reopen it. When the message it names is on an older
 * ticket, the reaction lands on this one with nothing here to pair it with,
 * which is the cheap way to be wrong about something rare.
 *
 * Processed in no order like everything else, so a reaction handled before the
 * message that opens the person's first conversation finds nothing and is not
 * stored. That is a reaction lost, which is the cheap side of the trade.
 */
export type WhatsAppReactionResult = {
  conversationId: string | null;
  conversationNumber: number;
  messageId: string | null;
  duplicate: boolean;
  /**
   * Why nothing was stored: an echo from a number whose echoes are our own
   * sends, or nowhere to file it — no conversation on the channel, or a copied
   * history newest of all.
   */
  skipped: 'not_mirrored' | 'no_conversation' | null;
};

export async function ingestWhatsAppReaction(
  reaction: NormalisedReaction,
): Promise<WhatsAppReactionResult> {
  const { wamid, phoneNumberId } = reaction.side === 'customer' ? reaction.message : reaction.echo;
  const customer = reaction.side === 'customer' ? reaction.message.from : reaction.echo.to;
  const channel = await resolveWhatsAppChannel(phoneNumberId);

  // Mirrored on the numbers the business's messages are, and on no other.
  const sender = reaction.side === 'business' ? echoSender(channel) : null;
  if (reaction.side === 'business' && !sender) return skipped('not_mirrored');

  const seen = await storedMessage(wamid);
  if (seen) return { ...seen, duplicate: true, skipped: null };

  // Looked up rather than resolved, as an interaction is: `resolveContact`
  // writes a contact when it finds none, and there is nothing to file under it.
  const contactId = await findContactByIdentity('whatsapp', customer);
  if (!contactId) return skipped('no_conversation');

  // A copied history newest of all is what the reaction is most likely about,
  // and a live row does not join a record — so it is not filed on the native
  // ticket before it either, which may be closed and months old.
  const conversation = await findNewestConversation(contactId, channel.kind);
  if (!conversation || conversation.imported) return skipped('no_conversation');

  const [row] = await db
    .insert(messages)
    .values(
      reaction.side === 'customer'
        ? inboundRow(conversation.id, contactId, reaction.message)
        : echoRow(conversation.id, reaction.echo, sender === 'business_app'),
    )
    .returning({ id: messages.id });

  return {
    conversationId: conversation.id,
    conversationNumber: conversation.number,
    messageId: row!.id,
    duplicate: false,
    skipped: null,
  };
}

function skipped(reason: 'not_mirrored' | 'no_conversation'): WhatsAppReactionResult {
  return {
    conversationId: null,
    conversationNumber: 0,
    messageId: null,
    duplicate: false,
    skipped: reason,
  };
}

/**
 * The row already stored under a wamid, and its ticket's number — the
 * idempotency check every path here makes before writing anything.
 */
async function storedMessage(
  wamid: string,
): Promise<{ conversationId: string; conversationNumber: number; messageId: string } | null> {
  const [row] = await db
    .select({
      conversationId: messages.conversationId,
      conversationNumber: conversations.number,
      messageId: messages.id,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.channelMessageId, wamid))
    .limit(1);
  return row ?? null;
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
 * against the number the conversation arrived on — and, for an expired token,
 * naming the credential it went out on.
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

  const arrivedOn = await lastInboundPhoneNumberId(message.conversationId);

  return explainDeliveryError(Number.isFinite(code) ? code : null, status.error, {
    windowOpen: windowState(message.lastCustomerMessageAt, status.at).isOpen,
    inboundPhoneNumberId: arrivedOn,
    sentFromPhoneNumberId: typeof sentFrom === 'string' ? sentFrom : null,
    // Only a 190 names a credential, so only a 190 pays to find out which.
    credential: code === ACCESS_TOKEN_CODE ? await sendingCredential(message.meta) : null,
  });
}

/**
 * Which credential a failed send authenticated with — or null when that can no
 * longer be told, which the sentence then says instead of blaming the shared
 * token.
 *
 * Answered from what `send_whatsapp` recorded and the configuration as it
 * stands, never by opening anything: `resolveCredentialSource` needs only
 * whether a credential is stored, which `hasStoredToken` reads off the account
 * row, and only the worker's resolvers may decrypt (`credential-confinement`).
 * The account the send recorded is asked first, because a channel can be moved
 * to another account after a send; the number is for a row recorded before the
 * account was. "As it stands" is the one approximation: a status follows its
 * send within seconds, and a credential changed in between is a reconnect
 * somebody has only just made.
 */
async function sendingCredential(meta: unknown): Promise<TokenOrigin | null> {
  const sent = meta as { phoneNumberId?: unknown; whatsappAccountId?: unknown; echo?: unknown };
  // Another service's message — the bot's, or a reply typed on the phone —
  // went out on a credential that is not ours to name.
  if (sent.echo === true) return null;

  let account: WhatsAppAccount | null;
  if (typeof sent.whatsappAccountId === 'string') {
    account = (await listAccounts()).find((row) => row.id === sent.whatsappAccountId) ?? null;
    // Deleted since, and what it sent with is gone with it.
    if (!account) return null;
  } else if (typeof sent.phoneNumberId === 'string') {
    // Null is no account at all, which is what the send resolved too: it went
    // out on the shared token.
    account = await accountForPhoneNumberId(sent.phoneNumberId);
  } else {
    return null;
  }

  const source = resolveCredentialSource(account, account?.hasStoredToken ?? false);
  return { source, tokenEnvVar: source === 'variable' ? (account?.tokenEnvVar ?? null) : null };
}

export type ResolvedChannel = {
  id: string | null;
  defaultGroupId: string | null;
  /** The conversation channel to file under — `whatsapp` or `whatsapp_bot`. */
  kind: 'whatsapp' | 'whatsapp_bot';
  /**
   * The number is also live on the WhatsApp Business app (coexistence), so an
   * echo on it is the business typing on the phone rather than our own send.
   */
  coexistence: boolean;
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
    .where(and(inArray(channels.type, ['whatsapp', 'whatsapp_bot']), eq(channels.isActive, true)))
    // Ordered for the fallback below. A number matches at most one row, but
    // "the support channel" for a number with none is a choice among rows.
    .orderBy(asc(channels.createdAt), asc(channels.id));

  const byNumber = phoneNumberId
    ? rows.find((c) => c.config?.phoneNumberId === phoneNumberId)
    : undefined;

  if (byNumber) {
    return {
      id: byNumber.id,
      defaultGroupId: byNumber.defaultGroupId,
      kind: byNumber.type === 'whatsapp_bot' ? 'whatsapp_bot' : 'whatsapp',
      coexistence: byNumber.type === 'whatsapp' && parseCoexistence(byNumber.config) !== null,
    };
  }

  // No row for this number. Only ever the support channel — a bot number is
  // known by its row, and inferring "bot" from the absence of one would hide
  // real customer messages from the team. And a support number rather than a
  // coexistence one where there is a choice: a coexistence row is somebody's
  // phone, with a default group of its own (production's Merchant Care
  // number), and a message on a number no row names is not its traffic.
  const support =
    rows.find((c) => c.type === 'whatsapp' && parseCoexistence(c.config) === null) ??
    rows.find((c) => c.type === 'whatsapp');
  // Not coexistence, whatever the support row is: the event came in on a
  // number no row names, and only a number's own row can say it is on the app.
  return {
    id: support?.id ?? null,
    defaultGroupId: support?.defaultGroupId ?? null,
    kind: 'whatsapp',
    coexistence: false,
  };
}

/** First line, trimmed to something that fits a ticket list. */
export function subjectFrom(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return UNNAMED_SUBJECT.whatsapp;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}
