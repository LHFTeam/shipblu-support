import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import type { NormalisedEcho, NormalisedInboundMessage } from '@/lib/whatsapp/types';
import { ingestWhatsAppEcho, ingestWhatsAppMessage } from './ingest-whatsapp';

/**
 * What the two WhatsApp ingest paths write today, quirks included, so the
 * shared ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * Against the seeded baseline, which carries one WhatsApp channel: the customer
 * bot's number, as `whatsapp_bot`. The support number has no row, so it files
 * under plain `whatsapp` with no channel — the documented fallback in
 * `resolveWhatsAppChannel`.
 */

withCleanDatabase();

const BOT_NUMBER = '128318316834446';
const SUPPORT_NUMBER = '100000000000001';
const CUSTOMER = '201001234567';
const SENT = new Date('2026-09-20T10:00:00Z');
const LATER = new Date('2026-09-20T11:30:00Z');

function inbound(overrides: Partial<NormalisedInboundMessage> = {}): NormalisedInboundMessage {
  return {
    wamid: 'wamid.first',
    from: CUSTOMER,
    phoneNumberId: SUPPORT_NUMBER,
    profileName: 'Amira',
    sentAt: SENT,
    type: 'text',
    text: 'Where is my parcel?\nIt was due yesterday.',
    media: null,
    location: null,
    replyToWamid: null,
    raw: { id: 'wamid.first' },
    ...overrides,
  };
}

function echo(overrides: Partial<NormalisedEcho> = {}): NormalisedEcho {
  return {
    wamid: 'wamid.bot-1',
    to: CUSTOMER,
    from: BOT_NUMBER,
    phoneNumberId: BOT_NUMBER,
    sentAt: SENT,
    type: 'text',
    text: 'Welcome to ShipBlu. Send your tracking number.',
    media: null,
    location: null,
    replyToWamid: null,
    creationType: null,
    raw: { id: 'wamid.bot-1' },
    ...overrides,
  };
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      requesterContactId: conversations.requesterContactId,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      slaPolicyId: conversations.slaPolicyId,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function eventTypes(conversationId: string) {
  const rows = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .orderBy(asc(conversationEvents.createdAt));
  return rows.map((row) => row.type);
}

async function setStatus(conversationId: string, name: string, extra = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!status) throw new Error(`no status ${name}`);
  await db
    .update(conversations)
    .set({ statusId: status.id, ...extra })
    .where(eq(conversations.id, conversationId));
}

async function agentId(): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  if (!agent) throw new Error('no agent');
  return agent.id;
}

async function botChannelId(): Promise<string> {
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.type, 'whatsapp_bot'));
  if (!row) throw new Error('the seed wrote no bot channel');
  return row.id;
}

describe('ingestWhatsAppMessage', () => {
  it('opens a ticket for a new number, named after the first line', async () => {
    const result = await ingestWhatsAppMessage(inbound());

    expect(result).toMatchObject({
      conversationNumber: 1,
      createdConversation: true,
      duplicate: false,
    });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ name: 'Amira' });
    expect(await db.select().from(contactIdentities)).toMatchObject([
      { contactId: contact?.id, channel: 'whatsapp', identifier: CUSTOMER },
    ]);

    expect(await conversation(result.conversationId)).toEqual({
      number: 1,
      channel: 'whatsapp',
      channelId: null,
      subject: 'Where is my parcel?',
      status: 'Open',
      requesterContactId: contact?.id,
      reopenCount: 0,
      resolvedAt: null,
      resolvedByAgentId: null,
      slaPolicyId: null,
      lastMessageAt: SENT,
      lastCustomerMessageAt: SENT,
    });

    expect(await messagesOf(result.conversationId)).toMatchObject([
      {
        id: result.messageId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contact?.id,
        bodyText: 'Where is my parcel?\nIt was due yesterday.',
        bodyHtml: null,
        channelMessageId: 'wamid.first',
        fromAddress: CUSTOMER,
        deliveryStatus: 'delivered',
        deliveredAt: SENT,
        meta: { whatsappType: 'text', profileName: 'Amira', phoneNumberId: SUPPORT_NUMBER },
        createdAt: SENT,
      },
    ]);

    expect(await eventTypes(result.conversationId)).toEqual(['categorised']);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('continues the customer’s live conversation: the thread is the number', async () => {
    const first = await ingestWhatsAppMessage(inbound());
    const second = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.second', text: 'Any news?', sentAt: LATER }),
    );

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(2);
    expect(await conversation(first.conversationId)).toMatchObject({
      lastMessageAt: LATER,
      lastCustomerMessageAt: LATER,
    });
  });

  it('reopens a resolved conversation, and records who had resolved it', async () => {
    const first = await ingestWhatsAppMessage(inbound());
    const resolver = await agentId();
    await setStatus(first.conversationId, 'Resolved', {
      resolvedAt: new Date('2026-09-20T10:30:00Z'),
      resolvedByAgentId: resolver,
    });

    const second = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.second', text: 'Still not here', sentAt: LATER }),
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(await conversation(first.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      // Left for the event to read, as the email path leaves it.
      resolvedByAgentId: resolver,
    });
    const [reopened] = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.type, 'reopened'));
    expect(reopened).toEqual({
      actorLabel: 'inbound_whatsapp',
      data: { reason: 'customer_replied', resolvedBy: resolver },
    });
  });

  // Unlike email, where a reply is appended to a closed ticket: here closing is
  // the end of the thread, and the next message starts another.
  it('opens a new conversation after the last one was closed', async () => {
    const first = await ingestWhatsAppMessage(inbound());
    await setStatus(first.conversationId, 'Closed');

    const second = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.second', text: 'New question', sentAt: LATER }),
    );

    expect(second).toMatchObject({ createdConversation: true, conversationNumber: 2 });
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
  });

  it('writes nothing the second time a wamid arrives', async () => {
    const first = await ingestWhatsAppMessage(inbound());
    const again = await ingestWhatsAppMessage(inbound());

    expect(again).toEqual({
      conversationId: first.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      createdConversation: false,
      duplicate: true,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
  });

  it('queues the media download at once, keyed on the media id', async () => {
    const result = await ingestWhatsAppMessage(
      inbound({
        type: 'image',
        text: '',
        media: {
          mediaId: 'media-1',
          mimeType: 'image/jpeg',
          filename: null,
          sha256: null,
          isVoice: false,
        },
      }),
    );

    expect(await conversation(result.conversationId)).toMatchObject({
      subject: 'WhatsApp conversation',
    });
    expect(
      await db
        .select({
          type: jobs.type,
          payload: jobs.payload,
          priority: jobs.priority,
          dedupeKey: jobs.dedupeKey,
        })
        .from(jobs),
    ).toEqual([
      {
        type: 'download_media',
        payload: { messageId: result.messageId, mediaId: 'media-1' },
        priority: 5,
        dedupeKey: 'download_media:media-1',
      },
    ]);
    const [message] = await messagesOf(result.conversationId);
    expect(message?.meta).toMatchObject({
      media: { mediaId: 'media-1', mimeType: 'image/jpeg', downloaded: false },
    });
  });

  describe('on the bot’s number', () => {
    it('files under the bot channel, and keeps the SLA out of it', async () => {
      // A default policy, so the support number has something to apply and
      // the bot number's skipping of `afterInboundMessage` is visible.
      const TARGET = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
      await db.insert(slaPolicies).values({
        name: 'default',
        isDefault: true,
        targets: { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET },
      });

      const bot = await ingestWhatsAppMessage(inbound({ phoneNumberId: BOT_NUMBER }));
      const support = await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.support', sentAt: LATER }),
      );

      expect(await conversation(bot.conversationId)).toMatchObject({
        channel: 'whatsapp_bot',
        channelId: await botChannelId(),
        slaPolicyId: null,
      });
      expect((await conversation(support.conversationId)).slaPolicyId).not.toBeNull();

      // One person, one contact, a conversation on each number.
      expect(support.conversationId).not.toBe(bot.conversationId);
      expect(await db.select().from(contacts)).toHaveLength(1);

      // Nor categorised, though `afterMessageStored` does run here: the
      // categoriser leaves read-only channels out itself, because the bot's
      // menu is a self-service funnel and not support demand.
      expect(await eventTypes(bot.conversationId)).toEqual([]);
    });
  });
});

describe('ingestWhatsAppEcho', () => {
  it('ignores an echo of the support number, which is our own reply coming back', async () => {
    const result = await ingestWhatsAppEcho(
      echo({ from: SUPPORT_NUMBER, phoneNumberId: SUPPORT_NUMBER }),
    );

    expect(result).toEqual({
      conversationId: null,
      conversationNumber: 0,
      messageId: null,
      createdConversation: false,
      duplicate: false,
      ignored: true,
    });
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(contacts)).toEqual([]);
  });

  it('opens the bot conversation when the bot speaks first, with no author', async () => {
    const result = await ingestWhatsAppEcho(echo());

    expect(result).toMatchObject({ createdConversation: true, duplicate: false, ignored: false });
    if (!result.conversationId) throw new Error('no conversation');

    expect(await conversation(result.conversationId)).toMatchObject({
      channel: 'whatsapp_bot',
      subject: 'Welcome to ShipBlu. Send your tracking number.',
      lastMessageAt: SENT,
      // The bot writing opens no window for us.
      lastCustomerMessageAt: null,
    });
    expect(await messagesOf(result.conversationId)).toMatchObject([
      {
        direction: 'outbound',
        kind: 'reply',
        authorContactId: null,
        authorAgentId: null,
        fromAddress: BOT_NUMBER,
        toAddresses: [CUSTOMER],
        deliveryStatus: 'sent',
        meta: { whatsappType: 'text', phoneNumberId: BOT_NUMBER, echo: true },
      },
    ]);
    // The contact exists, by number, with no name the bot could have told us.
    expect(await db.select({ name: contacts.name }).from(contacts)).toEqual([{ name: null }]);
  });

  it('threads the customer’s answer onto the conversation the bot opened', async () => {
    const opened = await ingestWhatsAppEcho(echo());
    const answer = await ingestWhatsAppMessage(
      inbound({ phoneNumberId: BOT_NUMBER, text: 'SB123456789', sentAt: LATER }),
    );

    expect(answer).toMatchObject({
      conversationId: opened.conversationId,
      createdConversation: false,
    });
  });

  // The bot answering is not the customer writing: it appends, reopens nothing,
  // and moves only the conversation's last activity.
  it('appends to a resolved bot conversation without reopening it', async () => {
    const asked = await ingestWhatsAppMessage(inbound({ phoneNumberId: BOT_NUMBER }));
    await setStatus(asked.conversationId, 'Resolved');
    const before = await conversation(asked.conversationId);

    const answered = await ingestWhatsAppEcho(echo({ sentAt: LATER }));

    expect(answered).toMatchObject({
      conversationId: asked.conversationId,
      createdConversation: false,
      duplicate: false,
    });
    expect(await messagesOf(asked.conversationId)).toHaveLength(2);
    expect(await conversation(asked.conversationId)).toMatchObject({
      status: 'Resolved',
      reopenCount: 0,
      lastMessageAt: LATER,
      lastCustomerMessageAt: before.lastCustomerMessageAt,
    });
    expect(await eventTypes(asked.conversationId)).not.toContain('reopened');
  });

  it('writes nothing the second time an echo’s wamid arrives', async () => {
    const first = await ingestWhatsAppEcho(echo());
    const again = await ingestWhatsAppEcho(echo());

    expect(again).toEqual({
      conversationId: first.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      createdConversation: false,
      duplicate: true,
      ignored: false,
    });
    expect(await db.select().from(messages)).toHaveLength(1);
  });
});
