import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  groups,
  jobs,
  messages,
  slaPolicies,
  ticketStatuses,
  whatsappAccounts,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { storeBusinessToken } from '@/lib/whatsapp/credentials';
import { heldByOrInGroupsOf } from '@/lib/tickets/assignment-scope';
import { changeStatus } from '@/lib/tickets/status';
import { handOverNumber } from '@/lib/whatsapp/number-owner';
import type {
  NormalisedEcho,
  NormalisedInboundMessage,
  NormalisedReaction,
} from '@/lib/whatsapp/types';
import {
  applyWhatsAppStatus,
  ingestWhatsAppEcho,
  ingestWhatsAppMessage,
  ingestWhatsAppReaction,
} from './ingest-whatsapp';
import { ingestWhatsAppHistoryChunk } from './ingest-whatsapp-history';

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

/**
 * A customer's reaction to `wamid.first`, as `parseWebhook` hands it over —
 * the delivery's own shape in `raw`, which is where the reacted-to message is
 * named. No emoji is the customer taking theirs back.
 */
function customerReaction(
  emoji: string | null,
  overrides: Partial<NormalisedInboundMessage> = {},
): NormalisedReaction {
  const wamid = overrides.wamid ?? 'wamid.reaction';
  return {
    side: 'customer',
    message: inbound({
      wamid,
      type: 'reaction',
      text: emoji ? `[reacted ${emoji}]` : '[reacted]',
      sentAt: LATER,
      raw: {
        id: wamid,
        from: CUSTOMER,
        type: 'reaction',
        reaction: { message_id: 'wamid.first', ...(emoji ? { emoji } : {}) },
      },
      ...overrides,
    }),
  };
}

/** The business's reaction to `wamid.first`, echoed back from its own number. */
function businessReaction(
  emoji: string,
  overrides: Partial<NormalisedEcho> = {},
): NormalisedReaction {
  const wamid = overrides.wamid ?? 'wamid.business-reaction';
  return {
    side: 'business',
    echo: echo({
      wamid,
      type: 'reaction',
      text: `[reacted ${emoji}]`,
      sentAt: LATER,
      raw: {
        id: wamid,
        to: CUSTOMER,
        type: 'reaction',
        reaction: { message_id: 'wamid.first', emoji },
      },
      ...overrides,
    }),
  };
}

/** Every column a reaction must leave as it found it. */
async function untouched(id: string) {
  const [row] = await db
    .select({
      status: ticketStatuses.name,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      lastAgentMessageAt: conversations.lastAgentMessageAt,
      firstResponseDueAt: conversations.firstResponseDueAt,
      nextResponseDueAt: conversations.nextResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
      firstRespondedAt: conversations.firstRespondedAt,
      priority: conversations.priority,
      assigneeAgentId: conversations.assigneeAgentId,
      autoRespondedAt: conversations.autoRespondedAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

/** A wall-clock policy, so a due date is the instant plus an hour. */
async function hourlyPolicy() {
  const target = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
  await db.insert(slaPolicies).values({
    name: 'default',
    isDefault: true,
    hoursSource: 'round_the_clock',
    targets: { low: target, medium: target, high: target, urgent: target },
  });
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

  // A number no row names is filed under no row, so it is nobody's number on
  // every path that asks, and routed to the plain support row's group. With a
  // coexistence phone and a plain support number both on file, an unordered
  // pick could take the phone's group — one person's team — and an ordered one
  // still would if the phone's row were older, as production's is not but
  // could be.
  it("files a number no row names under no row, in the support row's group, never a phone's", async () => {
    const [phoneTeam, supportTeam] = await db
      .insert(groups)
      .values([{ name: 'Phone owner team' }, { name: 'Support desk' }])
      .returning({ id: groups.id });
    await db.insert(channels).values([
      {
        type: 'whatsapp',
        name: 'Somebody’s phone',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        defaultGroupId: phoneTeam!.id,
        config: {
          phoneNumberId: '106540352242922',
          coexistence: { onboardedAt: '2026-09-01T00:00:00.000Z', wabaId: 'waba', syncs: {} },
        },
      },
      {
        type: 'whatsapp',
        name: 'WhatsApp Support',
        createdAt: new Date('2026-09-02T00:00:00Z'),
        defaultGroupId: supportTeam!.id,
        config: { phoneNumberId: '100000000000999' },
      },
    ]);

    const result = await ingestWhatsAppMessage(inbound());

    const [row] = await db
      .select({ channelId: conversations.channelId, groupId: conversations.groupId })
      .from(conversations)
      .where(eq(conversations.id, result.conversationId));
    expect(row).toEqual({ channelId: null, groupId: supportTeam!.id });
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

/**
 * A reaction is a row on the customer's thread and nothing more: what a 🙏 on
 * our reply asks of the team is nothing, so the ticket it lands on is left
 * exactly as it was. In production one support ticket had been reopened by
 * nothing but two 👍🏻, and two more counted their window from one (2026-10-13).
 */
describe('ingestWhatsAppReaction', () => {
  it('files the reaction on the live conversation and moves none of its clocks', async () => {
    await hourlyPolicy();
    const asked = await ingestWhatsAppMessage(inbound());
    const before = await untouched(asked.conversationId);
    const queued = await db.select().from(jobs);

    const reacted = await ingestWhatsAppReaction(customerReaction('🙏'));

    expect(reacted).toEqual({
      conversationId: asked.conversationId,
      conversationNumber: 1,
      messageId: expect.any(String),
      duplicate: false,
      skipped: null,
    });
    // The window, the next-response target and the inbox's order all stay
    // where the customer's question put them.
    expect(await untouched(asked.conversationId)).toEqual(before);
    expect(before).toMatchObject({
      lastMessageAt: SENT,
      lastCustomerMessageAt: SENT,
      // Counted from the ticket's own creation, which is now.
      firstResponseDueAt: expect.any(Date),
    });

    // Stored as the message it arrived as, so the timeline can pair it with the
    // message it names.
    const [, row] = await messagesOf(asked.conversationId);
    expect(row).toMatchObject({
      id: reacted.messageId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: (await conversation(asked.conversationId)).requesterContactId,
      bodyText: '[reacted 🙏]',
      channelMessageId: 'wamid.reaction',
      meta: { whatsappType: 'reaction', phoneNumberId: SUPPORT_NUMBER },
      createdAt: LATER,
    });
    expect(JSON.parse(row!.rawBody!)).toMatchObject({
      reaction: { message_id: 'wamid.first', emoji: '🙏' },
    });

    // Nothing downstream of a message ran: no categorisation of a 🙏, and
    // nothing queued for it.
    expect(await eventTypes(asked.conversationId)).toEqual(['categorised']);
    expect(await db.select().from(jobs)).toEqual(queued);
  });

  it('leaves a resolved conversation resolved', async () => {
    const asked = await ingestWhatsAppMessage(inbound());
    await setStatus(asked.conversationId, 'Resolved', {
      resolvedAt: new Date('2026-09-20T10:30:00Z'),
    });
    const before = await untouched(asked.conversationId);

    const reacted = await ingestWhatsAppReaction(customerReaction('👍'));

    expect(reacted.conversationId).toBe(asked.conversationId);
    expect(await untouched(asked.conversationId)).toEqual(before);
    expect(before).toMatchObject({ status: 'Resolved', reopenCount: 0 });
    expect(await eventTypes(asked.conversationId)).not.toContain('reopened');
  });

  it('files it on a closed conversation as it stands, and opens no ticket of its own', async () => {
    const asked = await ingestWhatsAppMessage(inbound());
    await setStatus(asked.conversationId, 'Closed');
    const before = await untouched(asked.conversationId);

    const reacted = await ingestWhatsAppReaction(customerReaction('❤️'));

    expect(reacted).toMatchObject({ conversationId: asked.conversationId, skipped: null });
    expect(await untouched(asked.conversationId)).toEqual(before);
    expect(await db.select().from(conversations)).toHaveLength(1);

    // Still finished: the customer's next message opens a new ticket, and their
    // next reaction goes on that one, the newest.
    const next = await ingestWhatsAppMessage(
      inbound({
        wamid: 'wamid.second',
        text: 'New question',
        sentAt: new Date('2026-09-21T09:00:00Z'),
      }),
    );
    expect(next).toMatchObject({ createdConversation: true, conversationNumber: 2 });
    const again = await ingestWhatsAppReaction(
      customerReaction('👍', {
        wamid: 'wamid.reaction-2',
        sentAt: new Date('2026-09-21T09:05:00Z'),
      }),
    );
    expect(again.conversationId).toBe(next.conversationId);
  });

  it('stores nothing, and makes no contact, for somebody with no conversation', async () => {
    const reacted = await ingestWhatsAppReaction(customerReaction('👍'));

    expect(reacted).toEqual({
      conversationId: null,
      conversationNumber: 0,
      messageId: null,
      duplicate: false,
      skipped: 'no_conversation',
    });
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it('files a reaction taken back like any other, for the console to undo the first', async () => {
    const asked = await ingestWhatsAppMessage(inbound());
    await ingestWhatsAppReaction(customerReaction('👍'));
    const before = await untouched(asked.conversationId);

    await ingestWhatsAppReaction(
      customerReaction(null, {
        wamid: 'wamid.unreaction',
        sentAt: new Date('2026-09-20T12:00:00Z'),
      }),
    );

    expect(await untouched(asked.conversationId)).toEqual(before);
    const rows = await messagesOf(asked.conversationId);
    expect(rows.map((row) => row.bodyText)).toEqual([
      'Where is my parcel?\nIt was due yesterday.',
      '[reacted 👍]',
      '[reacted]',
    ]);
    expect(JSON.parse(rows[2]!.rawBody!)).toEqual({
      id: 'wamid.unreaction',
      from: CUSTOMER,
      type: 'reaction',
      reaction: { message_id: 'wamid.first' },
    });
  });

  it('writes nothing the second time a reaction’s wamid arrives', async () => {
    const asked = await ingestWhatsAppMessage(inbound());
    const first = await ingestWhatsAppReaction(customerReaction('🙏'));

    expect(await ingestWhatsAppReaction(customerReaction('🙏'))).toEqual({
      conversationId: asked.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      duplicate: true,
      skipped: null,
    });
    expect(await messagesOf(asked.conversationId)).toHaveLength(2);
  });

  it('does not mirror a reaction echoed on an ordinary support number, which is our own', async () => {
    await ingestWhatsAppMessage(inbound());

    const reacted = await ingestWhatsAppReaction(
      businessReaction('👍', { from: SUPPORT_NUMBER, phoneNumberId: SUPPORT_NUMBER }),
    );

    expect(reacted).toMatchObject({ skipped: 'not_mirrored', messageId: null });
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  describe('on the bot’s number', () => {
    it('files it on the transcript without opening a window for us', async () => {
      const opened = await ingestWhatsAppEcho(echo());
      const before = await untouched(opened.conversationId!);

      const reacted = await ingestWhatsAppReaction(
        customerReaction('👍', { phoneNumberId: BOT_NUMBER }),
      );

      expect(reacted.conversationId).toBe(opened.conversationId);
      expect(await untouched(opened.conversationId!)).toEqual(before);
      expect(before.lastCustomerMessageAt).toBeNull();
    });

    // Most reactions on the bot's number name the bot's own messages, which
    // are not stored; 71 of them had opened a transcript holding nothing else.
    it('opens no transcript for a reaction that arrives first', async () => {
      expect(
        await ingestWhatsAppReaction(customerReaction('👍', { phoneNumberId: BOT_NUMBER })),
      ).toMatchObject({ skipped: 'no_conversation' });
      expect(await db.select().from(conversations)).toEqual([]);
    });
  });
});

/**
 * A support number connected through coexistence is also on the WhatsApp
 * Business app, so its echoes are the business typing on the phone — nothing
 * else wrote them, and the business decided they count as the team's reply.
 */
describe('ingestWhatsAppEcho on a number connected through coexistence', () => {
  const COEX_NUMBER = '106540352242922';
  const EARLIER = new Date('2026-09-20T09:00:00Z');

  async function coexistenceChannel() {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'ShipBlu on the phone',
        config: {
          phoneNumberId: COEX_NUMBER,
          coexistence: {
            onboardedAt: '2026-09-19T08:00:00.000Z',
            wabaId: '102290129340398',
            syncs: {},
          },
        },
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  const phoneEcho = (overrides: Partial<NormalisedEcho> = {}) =>
    echo({
      wamid: 'wamid.phone-1',
      from: '15550783881',
      phoneNumberId: COEX_NUMBER,
      text: 'On its way — it leaves the hub this afternoon.',
      sentAt: LATER,
      ...overrides,
    });

  async function clocks(id: string) {
    const [row] = await db
      .select({
        lastAgentMessageAt: conversations.lastAgentMessageAt,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
        lastMessageAt: conversations.lastMessageAt,
        firstRespondedAt: conversations.firstRespondedAt,
        nextResponseDueAt: conversations.nextResponseDueAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  async function categories() {
    return db
      .select({
        id: conversations.id,
        sourceSystem: conversations.sourceSystem,
        category: ticketStatuses.category,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .orderBy(asc(conversations.createdAt));
  }

  it("appends the phone's reply as the team's: answered, and no window opened", async () => {
    const channelId = await coexistenceChannel();
    const asked = await ingestWhatsAppMessage(inbound({ phoneNumberId: COEX_NUMBER }));

    const answered = await ingestWhatsAppEcho(phoneEcho());

    expect(answered).toMatchObject({
      conversationId: asked.conversationId,
      createdConversation: false,
      duplicate: false,
      ignored: false,
    });
    expect(await conversation(asked.conversationId)).toMatchObject({ channelId });
    expect(await clocks(asked.conversationId)).toMatchObject({
      lastAgentMessageAt: LATER,
      lastMessageAt: LATER,
      firstRespondedAt: LATER,
      nextResponseDueAt: null,
      // The customer's alone: the business writing opens no 24-hour window.
      lastCustomerMessageAt: SENT,
    });
    const [, reply] = await messagesOf(asked.conversationId);
    expect(reply).toMatchObject({
      direction: 'outbound',
      authorAgentId: null,
      authorContactId: null,
      deliveryStatus: 'sent',
      meta: { echo: true, echoSource: 'business_app', phoneNumberId: COEX_NUMBER },
    });
  });

  it('never moves the team’s clock back for an echo processed late', async () => {
    await coexistenceChannel();
    const asked = await ingestWhatsAppMessage(
      inbound({ phoneNumberId: COEX_NUMBER, sentAt: EARLIER }),
    );
    await ingestWhatsAppEcho(phoneEcho());

    await ingestWhatsAppEcho(phoneEcho({ wamid: 'wamid.phone-0', sentAt: SENT }));

    expect(await clocks(asked.conversationId)).toMatchObject({
      lastAgentMessageAt: LATER,
      lastMessageAt: LATER,
      // The first answer is the earliest one, whichever was processed first.
      firstRespondedAt: SENT,
    });
  });

  it('opens the conversation resolved when the business writes first, already answered', async () => {
    await coexistenceChannel();

    const opened = await ingestWhatsAppEcho(phoneEcho());

    expect(opened).toMatchObject({ createdConversation: true, ignored: false });
    expect(await clocks(opened.conversationId!)).toMatchObject({
      lastAgentMessageAt: LATER,
      firstRespondedAt: LATER,
      lastCustomerMessageAt: null,
    });
    // Nothing is owed on the business's own message, so it is not in the
    // queue — and nobody resolved it, so no rollup counts a resolution.
    expect(await conversation(opened.conversationId!)).toMatchObject({
      status: 'Resolved',
      resolvedAt: null,
    });
  });

  it('files the phone’s first message beside an import, and the customer’s answer reopens it', async () => {
    await coexistenceChannel();
    await ingestWhatsAppHistoryChunk(
      {
        phoneNumberId: COEX_NUMBER,
        phase: 0,
        chunkOrder: 1,
        progress: 100,
        declined: null,
        messages: [
          {
            wamid: 'wamid.history-1',
            customer: CUSTOMER,
            direction: 'inbound',
            sentAt: EARLIER,
            type: 'text',
            text: 'Is it shipped?',
            mediaPlaceholder: false,
            location: null,
            replyToWamid: null,
            phoneStatus: null,
            raw: { id: 'wamid.history-1', from: CUSTOMER },
          },
        ],
      },
      EARLIER,
    );
    const [archive] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.sourceSystem, 'import'));

    const opened = await ingestWhatsAppEcho(phoneEcho({ sentAt: SENT }));
    const again = await ingestWhatsAppEcho(phoneEcho({ wamid: 'wamid.phone-2', sentAt: LATER }));

    expect(opened).toMatchObject({ createdConversation: true });
    expect(opened.conversationId).not.toBe(archive!.id);
    expect(again).toMatchObject({
      conversationId: opened.conversationId,
      createdConversation: false,
    });
    expect(await categories()).toEqual([
      { id: archive!.id, sourceSystem: 'import', category: 'resolved' },
      { id: opened.conversationId, sourceSystem: 'native', category: 'resolved' },
    ]);
    expect(await messagesOf(archive!.id)).toHaveLength(1);

    const answer = await ingestWhatsAppMessage(
      inbound({
        phoneNumberId: COEX_NUMBER,
        sentAt: new Date('2026-09-20T12:00:00Z'),
      }),
    );

    expect(answer).toMatchObject({
      conversationId: opened.conversationId,
      createdConversation: false,
    });
    expect(await categories()).toEqual([
      { id: archive!.id, sourceSystem: 'import', category: 'resolved' },
      { id: opened.conversationId, sourceSystem: 'native', category: 'open' },
    ]);
    expect((await clocks(opened.conversationId!)).lastCustomerMessageAt).toEqual(
      new Date('2026-09-20T12:00:00Z'),
    );
  });

  /**
   * A reply typed on the phone answers what came before it. Deliveries are
   * processed in no order, so a phone reply can be processed after a customer
   * message it never saw; the clocks must come out as they would have in
   * arrival order, whichever worker got there first.
   */
  describe('the response clocks, whatever order the deliveries are processed in', () => {
    const at = (time: string) => new Date(`2026-09-20T${time}:00Z`);
    let sequence = 0;

    async function hourlyPolicy() {
      const target = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
      await db.insert(slaPolicies).values({
        name: 'default',
        isDefault: true,
        // Wall-clock, so a due date is the instant plus an hour.
        hoursSource: 'round_the_clock',
        targets: { low: target, medium: target, high: target, urgent: target },
      });
    }

    const customer = (time: string) =>
      ingestWhatsAppMessage(
        inbound({
          wamid: `wamid.customer-${++sequence}`,
          phoneNumberId: COEX_NUMBER,
          sentAt: at(time),
        }),
      );
    const phone = (time: string) =>
      ingestWhatsAppEcho(phoneEcho({ wamid: `wamid.phone-${++sequence}`, sentAt: at(time) }));

    it('keeps the clock a newer customer message started when an older phone reply lands late', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:00');
      await phone('09:30');
      await customer('10:05');

      await phone('10:00');

      expect(await clocks(conversationId)).toMatchObject({
        nextResponseDueAt: at('11:05'),
        lastAgentMessageAt: at('10:00'),
        firstRespondedAt: at('09:30'),
      });
    });

    it('starts the clock for a message that came in before anybody had answered', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:55');
      await customer('10:05');

      await phone('10:00');

      expect(await clocks(conversationId)).toMatchObject({
        firstRespondedAt: at('10:00'),
        nextResponseDueAt: at('11:05'),
      });
    });

    it('owes nothing when a later reply already answered the newer message', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:55');
      await customer('10:05');
      await phone('10:20');

      await phone('10:00');

      expect(await clocks(conversationId)).toMatchObject({
        firstRespondedAt: at('10:00'),
        lastAgentMessageAt: at('10:20'),
        nextResponseDueAt: null,
      });
    });

    it('leaves a running clock where it is, pause credit included', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:00');
      await phone('09:30');
      await customer('10:05');
      // Half an hour on a status that stops the clock, credited on resume.
      await db
        .update(conversations)
        .set({ nextResponseDueAt: at('11:35') })
        .where(eq(conversations.id, conversationId));

      await phone('10:00');

      expect((await clocks(conversationId)).nextResponseDueAt).toEqual(at('11:35'));
    });

    it('stops the clock for a reply newer than everything the customer wrote', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:00');
      await phone('09:30');
      await customer('10:05');

      await phone('10:10');

      expect(await clocks(conversationId)).toMatchObject({
        nextResponseDueAt: null,
        lastAgentMessageAt: at('10:10'),
      });
    });

    it('never moves the customer’s clocks back for a message processed late', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const { conversationId } = await customer('09:00');
      await phone('09:30');
      await customer('10:05');

      await customer('09:50');

      expect(await clocks(conversationId)).toMatchObject({
        lastCustomerMessageAt: at('10:05'),
        lastMessageAt: at('10:05'),
        nextResponseDueAt: at('11:05'),
      });
    });
  });

  it('stops no clock a second time for a redelivered echo', async () => {
    await coexistenceChannel();
    const asked = await ingestWhatsAppMessage(inbound({ phoneNumberId: COEX_NUMBER }));
    await ingestWhatsAppEcho(phoneEcho());
    await db
      .update(conversations)
      .set({ firstRespondedAt: null })
      .where(eq(conversations.id, asked.conversationId));

    expect(await ingestWhatsAppEcho(phoneEcho())).toMatchObject({ duplicate: true });
    expect((await clocks(asked.conversationId)).firstRespondedAt).toBeNull();
  });

  /**
   * Both sides of the chat react on a coexistence number: the customer to the
   * reply the business typed on the phone, the business to the customer's
   * message. Neither is somebody answering. Seven of the fourteen reactions the
   * business sent from the phone had stopped a ticket's response clocks.
   */
  describe('a reaction, from either side', () => {
    const at = (time: string) => new Date(`2026-09-20T${time}:00Z`);
    const phoneReaction = (emoji: string, time: string) =>
      businessReaction(emoji, {
        from: '15550783881',
        phoneNumberId: COEX_NUMBER,
        sentAt: at(time),
      });

    it('restarts no response clock when the customer reacts to the phone’s reply', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const asked = await ingestWhatsAppMessage(
        inbound({ phoneNumberId: COEX_NUMBER, sentAt: at('09:00') }),
      );
      await ingestWhatsAppEcho(phoneEcho({ sentAt: at('09:30') }));
      const answered = await untouched(asked.conversationId);

      await ingestWhatsAppReaction(
        customerReaction('🙏', { phoneNumberId: COEX_NUMBER, sentAt: at('09:40') }),
      );

      expect(await untouched(asked.conversationId)).toEqual(answered);
      expect(answered).toMatchObject({
        nextResponseDueAt: null,
        lastCustomerMessageAt: at('09:00'),
        lastMessageAt: at('09:30'),
      });

      // The clock is still the customer's to start, by writing.
      await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.second', phoneNumberId: COEX_NUMBER, sentAt: at('10:05') }),
      );
      expect((await untouched(asked.conversationId)).nextResponseDueAt).toEqual(at('11:05'));
    });

    it('does not count the business’s reaction from the phone as an answer', async () => {
      await coexistenceChannel();
      await hourlyPolicy();
      const asked = await ingestWhatsAppMessage(
        inbound({ phoneNumberId: COEX_NUMBER, sentAt: at('09:00') }),
      );
      const before = await untouched(asked.conversationId);

      const reacted = await ingestWhatsAppReaction(phoneReaction('❤️', '09:10'));

      expect(reacted).toMatchObject({ conversationId: asked.conversationId, skipped: null });
      expect(await untouched(asked.conversationId)).toEqual(before);
      expect(before).toMatchObject({
        firstRespondedAt: null,
        lastAgentMessageAt: null,
        firstResponseDueAt: expect.any(Date),
      });
      const [, row] = await messagesOf(asked.conversationId);
      expect(row).toMatchObject({
        direction: 'outbound',
        authorAgentId: null,
        authorContactId: null,
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
      });
    });

    // A coexistence customer's newest thread with us is often the copied phone
    // history, and a reaction to it must not land on whatever native ticket came
    // before — closed, and possibly months old.
    it('files nothing when the newest conversation is a copied history', async () => {
      await coexistenceChannel();
      const old = await ingestWhatsAppMessage(
        inbound({ phoneNumberId: COEX_NUMBER, sentAt: EARLIER }),
      );
      await setStatus(old.conversationId, 'Closed');
      await ingestWhatsAppHistoryChunk(
        {
          phoneNumberId: COEX_NUMBER,
          phase: 0,
          chunkOrder: 1,
          progress: 100,
          declined: null,
          messages: [
            {
              wamid: 'wamid.history-1',
              customer: CUSTOMER,
              direction: 'outbound',
              sentAt: SENT,
              type: 'text',
              text: 'Your parcel is out for delivery.',
              mediaPlaceholder: false,
              location: null,
              replyToWamid: null,
              phoneStatus: null,
              raw: { id: 'wamid.history-1', to: CUSTOMER },
            },
          ],
        },
        SENT,
      );

      expect(
        await ingestWhatsAppReaction(
          customerReaction('👍', { phoneNumberId: COEX_NUMBER, sentAt: at('10:30') }),
        ),
      ).toMatchObject({ skipped: 'no_conversation' });
      expect(await messagesOf(old.conversationId)).toHaveLength(1);

      // Once they write, the new ticket is the newest, and the next one lands there.
      const next = await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.second', phoneNumberId: COEX_NUMBER, sentAt: at('12:00') }),
      );
      expect(next).toMatchObject({ createdConversation: true });
      expect(
        await ingestWhatsAppReaction(
          customerReaction('👍', {
            wamid: 'wamid.reaction-2',
            phoneNumberId: COEX_NUMBER,
            sentAt: at('12:05'),
          }),
        ),
      ).toMatchObject({ conversationId: next.conversationId, skipped: null });
    });

    it('opens no conversation for the business’s reaction, beside an import or not', async () => {
      await coexistenceChannel();
      expect(await ingestWhatsAppReaction(phoneReaction('👍', '09:10'))).toMatchObject({
        skipped: 'no_conversation',
      });

      // The copied history is a record, and a live reaction does not join it.
      await ingestWhatsAppHistoryChunk(
        {
          phoneNumberId: COEX_NUMBER,
          phase: 0,
          chunkOrder: 1,
          progress: 100,
          declined: null,
          messages: [
            {
              wamid: 'wamid.first',
              customer: CUSTOMER,
              direction: 'inbound',
              sentAt: EARLIER,
              type: 'text',
              text: 'Is it shipped?',
              mediaPlaceholder: false,
              location: null,
              replyToWamid: null,
              phoneStatus: null,
              raw: { id: 'wamid.first', from: CUSTOMER },
            },
          ],
        },
        EARLIER,
      );

      expect(await ingestWhatsAppReaction(phoneReaction('👍', '09:20'))).toMatchObject({
        skipped: 'no_conversation',
      });
      expect(
        await ingestWhatsAppReaction(
          customerReaction('👍', { phoneNumberId: COEX_NUMBER, sentAt: at('09:25') }),
        ),
      ).toMatchObject({ skipped: 'no_conversation' });
      expect(await categories()).toEqual([
        { id: expect.any(String), sourceSystem: 'import', category: 'resolved' },
      ]);
      expect(await db.select().from(messages)).toHaveLength(1);
    });
  });
});

/**
 * A WhatsApp conversation is the customer's thread with one of our numbers, and
 * a number can be one team member's phone. A merchant writing to two members is
 * two tickets, each answered from its own phone and measured against its own
 * person — so nothing that arrives on one number may land on, or move the
 * clocks of, the other's ticket.
 */
describe('a customer writing to two of our numbers', () => {
  const NUMBER_A = '106540352242922';
  const NUMBER_B = '106540352242933';

  /** A team member's phone, connected through coexistence. */
  async function phone(name: string, phoneNumberId: string) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name,
        config: {
          phoneNumberId,
          coexistence: {
            onboardedAt: '2026-09-19T08:00:00.000Z',
            wabaId: `waba-${phoneNumberId}`,
            syncs: {},
          },
        },
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  const phoneEcho = (phoneNumberId: string, overrides: Partial<NormalisedEcho> = {}) =>
    echo({
      wamid: `wamid.phone-${phoneNumberId}`,
      from: '15550783881',
      phoneNumberId,
      text: 'On its way — it leaves the hub this afternoon.',
      sentAt: LATER,
      ...overrides,
    });

  async function clocks(id: string) {
    const [row] = await db
      .select({
        lastAgentMessageAt: conversations.lastAgentMessageAt,
        firstRespondedAt: conversations.firstRespondedAt,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  it('opens a ticket on each number, each filed under its own row', async () => {
    const a = await phone('Nayera', NUMBER_A);
    const b = await phone('Omar', NUMBER_B);

    const toA = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_A }));
    const toB = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.second', phoneNumberId: NUMBER_B, sentAt: LATER }),
    );

    expect(toB).toMatchObject({ createdConversation: true });
    expect(toB.conversationId).not.toBe(toA.conversationId);
    expect(await conversation(toA.conversationId)).toMatchObject({
      channelId: a,
      lastCustomerMessageAt: SENT,
    });
    expect(await conversation(toB.conversationId)).toMatchObject({
      channelId: b,
      lastCustomerMessageAt: LATER,
    });
    // One person, on both tickets.
    expect(await db.select().from(contacts)).toHaveLength(1);
    expect(await messagesOf(toA.conversationId)).toHaveLength(1);
    expect(await messagesOf(toB.conversationId)).toHaveLength(1);

    // And each number goes on continuing its own.
    const again = await ingestWhatsAppMessage(
      inbound({
        wamid: 'wamid.third',
        phoneNumberId: NUMBER_A,
        sentAt: new Date('2026-09-20T12:00:00Z'),
      }),
    );
    expect(again).toMatchObject({ conversationId: toA.conversationId, createdConversation: false });
  });

  // Keyed on the person alone, the phone's reply went on the customer's newest
  // live ticket — the other number's — and stopped that ticket's clocks.
  it('files a reply typed on one phone on that number’s ticket, and stops no other clock', async () => {
    await phone('Nayera', NUMBER_A);
    await phone('Omar', NUMBER_B);
    const toB = await ingestWhatsAppMessage(
      inbound({ phoneNumberId: NUMBER_B, sentAt: new Date('2026-09-20T09:00:00Z') }),
    );
    // A's ticket is the newer of the two.
    const toA = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.second', phoneNumberId: NUMBER_A, sentAt: SENT }),
    );

    const answered = await ingestWhatsAppEcho(phoneEcho(NUMBER_B));

    expect(answered).toMatchObject({
      conversationId: toB.conversationId,
      createdConversation: false,
    });
    expect(await clocks(toB.conversationId)).toMatchObject({
      lastAgentMessageAt: LATER,
      firstRespondedAt: LATER,
    });
    expect(await clocks(toA.conversationId)).toEqual({
      lastAgentMessageAt: null,
      firstRespondedAt: null,
      lastMessageAt: SENT,
    });
    expect(await messagesOf(toA.conversationId)).toHaveLength(1);
  });

  it('opens the phone’s own ticket when the customer has one only with the other number', async () => {
    await phone('Nayera', NUMBER_A);
    const b = await phone('Omar', NUMBER_B);
    const toA = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_A }));

    const opened = await ingestWhatsAppEcho(phoneEcho(NUMBER_B));

    expect(opened).toMatchObject({ createdConversation: true });
    expect(await conversation(opened.conversationId!)).toMatchObject({
      channelId: b,
      status: 'Resolved',
    });
    expect(await clocks(toA.conversationId)).toMatchObject({
      lastAgentMessageAt: null,
      firstRespondedAt: null,
    });
  });

  it('files a reaction on that number’s thread, never the other’s', async () => {
    await phone('Nayera', NUMBER_A);
    await phone('Omar', NUMBER_B);

    // With a ticket only on A, a reaction on B has nowhere to go.
    const toA = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_A, sentAt: SENT }));
    expect(
      await ingestWhatsAppReaction(customerReaction('👍', { phoneNumberId: NUMBER_B })),
    ).toMatchObject({ skipped: 'no_conversation' });

    // B's ticket is the older one; the reaction still goes there.
    const toB = await ingestWhatsAppMessage(
      inbound({
        wamid: 'wamid.second',
        phoneNumberId: NUMBER_B,
        sentAt: new Date('2026-09-20T09:00:00Z'),
      }),
    );
    const reacted = await ingestWhatsAppReaction(
      customerReaction('🙏', { wamid: 'wamid.reaction-b', phoneNumberId: NUMBER_B }),
    );

    expect(reacted).toMatchObject({ conversationId: toB.conversationId, skipped: null });
    expect(await messagesOf(toA.conversationId)).toHaveLength(1);
    expect(await messagesOf(toB.conversationId)).toHaveLength(2);
  });

  // Production has four pairs of tickets on one number created 35–120 ms
  // apart: two deliveries each found no live ticket and each opened one. Every
  // customer here sends a message while the phone answers it, all at once.
  it('opens one ticket for a message and a reply processed at the same moment', async () => {
    const b = await phone('Omar', NUMBER_B);
    const customers = ['201001110001', '201001110002', '201001110003', '201001110004'];

    await Promise.all(
      customers.flatMap((customer) => [
        ingestWhatsAppMessage(
          inbound({ wamid: `wamid.in-${customer}`, from: customer, phoneNumberId: NUMBER_B }),
        ),
        ingestWhatsAppEcho(phoneEcho(NUMBER_B, { wamid: `wamid.out-${customer}`, to: customer })),
      ]),
    );

    const rows = await db
      .select({ id: conversations.id, channelId: conversations.channelId })
      .from(conversations);
    expect(rows).toHaveLength(customers.length);
    for (const row of rows) {
      expect(row.channelId).toBe(b);
      expect(await messagesOf(row.id)).toHaveLength(2);
    }
  });

  // The fallback for a number no row names hands out no row, even when a
  // coexistence one is all there is: the thread is keyed on the row, so that
  // row's id would file a stranger's number onto somebody's phone and its
  // tickets.
  it('never threads a number no row names onto a coexistence phone', async () => {
    const a = await phone('Nayera', NUMBER_A);
    const toA = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_A }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const unknown = await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.second', phoneNumberId: SUPPORT_NUMBER, sentAt: LATER }),
      );

      expect(unknown).toMatchObject({ createdConversation: true });
      expect(await conversation(unknown.conversationId)).toMatchObject({ channelId: null });
      expect(await conversation(toA.conversationId)).toMatchObject({
        channelId: a,
        lastCustomerMessageAt: SENT,
      });
      // Said, so a number connected at Meta and never added as a channel shows,
      // with its key last, as every line of the logger puts it.
      expect(warn).toHaveBeenCalledWith(
        `[whatsapp_ingest] no channel row for this number, filed under no row phone_number_id=${SUPPORT_NUMBER}`,
      );

      // Events on numbers no row names still thread with each other.
      const more = await ingestWhatsAppMessage(
        inbound({
          wamid: 'wamid.third',
          phoneNumberId: SUPPORT_NUMBER,
          sentAt: new Date('2026-09-20T12:00:00Z'),
        }),
      );
      expect(more.conversationId).toBe(unknown.conversationId);
    } finally {
      warn.mockRestore();
    }
  });

  // With no plain row to lend one, a coexistence row's default group still
  // routes the message — a team looks at it — while the ticket stays under no
  // row, so it is not that phone's, its owner's or their clocks'.
  it("routes a number no row names to a phone's group when there is no plain row", async () => {
    const [team] = await db
      .insert(groups)
      .values({ name: 'Phone team' })
      .returning({ id: groups.id });
    const a = await phone('Nayera', NUMBER_A);
    await db.update(channels).set({ defaultGroupId: team!.id }).where(eq(channels.id, a));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const unknown = await ingestWhatsAppMessage(inbound({ phoneNumberId: SUPPORT_NUMBER }));

      const [row] = await db
        .select({ channelId: conversations.channelId, groupId: conversations.groupId })
        .from(conversations)
        .where(eq(conversations.id, unknown.conversationId));
      expect(row).toEqual({ channelId: null, groupId: team!.id });
    } finally {
      warn.mockRestore();
    }
  });

  // The row an admin adds for a number that had none is what the warning asks
  // for. Keyed on the new row, the customer's next message would miss the
  // ticket open under no row and open a second, leaving a clock on the first
  // that nothing stops; it continues the first and files it under the row.
  it('continues a ticket filed under no row once its number has a row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_B }));
      expect(await conversation(before.conversationId)).toMatchObject({ channelId: null });

      const b = await phone('Ali', NUMBER_B);
      const after = await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.after', phoneNumberId: NUMBER_B, sentAt: LATER }),
      );

      expect(after).toMatchObject({
        conversationId: before.conversationId,
        createdConversation: false,
      });
      expect(await conversation(before.conversationId)).toMatchObject({ channelId: b });
    } finally {
      warn.mockRestore();
    }
  });

  // Under no row sit the tickets of every number no row names, so only one
  // whose customer last wrote to this number is this number's to take.
  it('leaves a ticket under no row alone when its customer last wrote to another number', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const elsewhere = await ingestWhatsAppMessage(inbound({ phoneNumberId: NUMBER_A }));

      const b = await phone('Ali', NUMBER_B);
      const toB = await ingestWhatsAppMessage(
        inbound({ wamid: 'wamid.to-b', phoneNumberId: NUMBER_B, sentAt: LATER }),
      );

      expect(toB).toMatchObject({ createdConversation: true });
      expect(toB.conversationId).not.toBe(elsewhere.conversationId);
      expect(await conversation(toB.conversationId)).toMatchObject({ channelId: b });
      expect(await conversation(elsewhere.conversationId)).toMatchObject({ channelId: null });
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * A number handed to one team member: the tickets arriving on it are theirs to
 * answer and to answer for, from the moment ingest creates them — and only then,
 * at a handover, or when a resolved one comes back after one.
 */
describe('a number that belongs to a team member', () => {
  const OWNED = '106540352242944';

  async function person(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const [row] = await db
      .insert(agents)
      .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`, ...values })
      .returning({ id: agents.id });
    return row!.id;
  }

  /** The owner's phone, connected through coexistence. */
  async function ownedPhone(ownerAgentId: string | null) {
    const [row] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'Nayera Mohamed',
        ownerAgentId,
        config: {
          phoneNumberId: OWNED,
          coexistence: { onboardedAt: '2026-09-19T08:00:00.000Z', wabaId: 'waba', syncs: {} },
        },
      })
      .returning({ id: channels.id });
    return row!.id;
  }

  async function holders(id: string) {
    const [row] = await db
      .select({
        accountable: conversations.accountableAgentId,
        assignee: conversations.assigneeAgentId,
        assigned: conversations.assignedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return {
      accountable: row!.accountable,
      assignee: row!.assignee,
      assigned: row!.assigned !== null,
    };
  }

  /** The events that say whose a ticket is, oldest first. */
  async function ownership(id: string) {
    const rows = await db
      .select({
        type: conversationEvents.type,
        actorAgentId: conversationEvents.actorAgentId,
        actorLabel: conversationEvents.actorLabel,
        data: conversationEvents.data,
      })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id))
      .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.type));
    return rows.filter((row) =>
      ['assigned', 'unassigned', 'accountable_changed', 'assignment_skipped'].includes(row.type),
    );
  }

  const toOwned = (overrides: Partial<NormalisedInboundMessage> = {}) =>
    inbound({ phoneNumberId: OWNED, ...overrides });

  it('gives a new ticket to the owner: theirs to answer, and theirs to answer for', async () => {
    const nayera = await person('Nayera Mohamed');
    const channelId = await ownedPhone(nayera);

    const result = await ingestWhatsAppMessage(toOwned());

    expect(await holders(result.conversationId)).toEqual({
      accountable: nayera,
      assignee: nayera,
      assigned: true,
    });
    // Nobody chose it, and the assignment that runs after ingest found it
    // already placed and said nothing.
    expect(await ownership(result.conversationId)).toEqual([
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'number_owner',
        data: { to: nayera, reason: 'number_owner', channelId },
      },
    ]);
  });

  it('stamps nobody while the owner is deactivated', async () => {
    const nayera = await person('Nayera Mohamed', { isActive: false });
    await ownedPhone(nayera);

    const result = await ingestWhatsAppMessage(toOwned());

    expect(await holders(result.conversationId)).toEqual({
      accountable: null,
      assignee: null,
      assigned: false,
    });
    expect(await ownership(result.conversationId)).toEqual([]);
  });

  // The fallback files a number no row names under no row, so the support
  // row's owner — who holds the support number, not this one — is never
  // charged for it.
  it('stamps nobody on a number no row names, or on the bot, whoever owns the support row', async () => {
    const nayera = await person('Nayera Mohamed');
    const [support] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'WhatsApp Support',
        ownerAgentId: nayera,
        config: { phoneNumberId: '100000000000099' },
      })
      .returning({ id: channels.id });

    const unknown = await ingestWhatsAppMessage(inbound());
    const bot = await ingestWhatsAppMessage(
      inbound({ wamid: 'wamid.bot', phoneNumberId: BOT_NUMBER }),
    );

    expect(await conversation(unknown.conversationId)).toMatchObject({ channelId: null });
    expect(support).toBeDefined();
    for (const id of [unknown.conversationId, bot.conversationId]) {
      expect(await holders(id)).toEqual({ accountable: null, assignee: null, assigned: false });
      expect(await ownership(id)).toEqual([]);
    }
  });

  // Every path that asks whose number a ticket is on keys on `channel_id`:
  // visibility, a handover, a reopen by hand. Filed under the support row, a
  // number no row names was nobody's at ingest and the support owner's on each
  // of those — whether it counted against somebody depended on which path
  // touched it last. Under no row it is nobody's on all four.
  it("keeps a number no row names off the support row's owner on every path", async () => {
    const admin = await person('Mona Admin', { role: 'admin' });
    const nayera = await person('Nayera Mohamed');
    const ali = await person('Ali Nasser');
    const [support] = await db
      .insert(channels)
      .values({
        type: 'whatsapp',
        name: 'WhatsApp Support',
        ownerAgentId: nayera,
        config: { phoneNumberId: '100000000000099' },
      })
      .returning({ id: channels.id });

    const own = await ingestWhatsAppMessage(inbound({ phoneNumberId: '100000000000099' }));
    const unknown = await ingestWhatsAppMessage(inbound({ wamid: 'wamid.unnamed', sentAt: LATER }));

    // Ingest: its own ticket, apart from the support number's, and nobody's.
    expect(unknown.conversationId).not.toBe(own.conversationId);
    expect(await conversation(unknown.conversationId)).toMatchObject({ channelId: null });
    expect(await holders(unknown.conversationId)).toMatchObject({ accountable: null });

    // Visibility: the support row's owner sees the support number's ticket, not this one.
    const seen = async (agentId: string, id: string) =>
      (
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, id), heldByOrInGroupsOf(agentId, false)))
      ).length > 0;
    expect(await seen(nayera, own.conversationId)).toBe(true);
    expect(await seen(nayera, unknown.conversationId)).toBe(false);

    // A handover of the support row moves its own ticket and not this one.
    await handOverNumber({
      channelId: support!.id,
      toAgentId: ali,
      actor: { id: admin, label: 'Mona Admin' },
    });
    expect(await holders(own.conversationId)).toMatchObject({ accountable: ali });
    expect(await holders(unknown.conversationId)).toMatchObject({ accountable: null });

    // Nor does a reopen by hand put it on the owner.
    await setStatus(unknown.conversationId, 'Resolved');
    const [open] = await db
      .select({
        id: ticketStatuses.id,
        name: ticketStatuses.name,
        category: ticketStatuses.category,
        stopsSlaClock: ticketStatuses.stopsSlaClock,
      })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    await changeStatus(admin, unknown.conversationId, open!);
    expect(await holders(unknown.conversationId)).toMatchObject({
      accountable: null,
      assignee: null,
    });
  });

  it('stamps a ticket the owner opened from the phone, resolved as it is', async () => {
    const nayera = await person('Nayera Mohamed');
    await ownedPhone(nayera);

    const opened = await ingestWhatsAppEcho(
      echo({ wamid: 'wamid.phone', from: '15550783881', phoneNumberId: OWNED }),
    );

    expect(opened).toMatchObject({ createdConversation: true });
    expect(await conversation(opened.conversationId!)).toMatchObject({ status: 'Resolved' });
    expect(await holders(opened.conversationId!)).toEqual({
      accountable: nayera,
      assignee: nayera,
      assigned: true,
    });
    expect((await ownership(opened.conversationId!)).map((e) => e.data.reason)).toEqual([
      'number_owner',
    ]);
  });

  // The handover moved the open tickets and left this one, because it was
  // resolved. The customer writing again is when it follows the phone.
  it("brings a resolved ticket over to the number's new owner when its customer writes again", async () => {
    const admin = await person('Mona Admin', { role: 'admin' });
    const nayera = await person('Nayera Mohamed');
    const ali = await person('Ali Nasser');
    const channelId = await ownedPhone(nayera);

    const first = await ingestWhatsAppMessage(toOwned());
    await setStatus(first.conversationId, 'Resolved');
    await handOverNumber({ channelId, toAgentId: ali, actor: { id: admin, label: 'Mona Admin' } });
    expect(await holders(first.conversationId)).toMatchObject({
      accountable: nayera,
      assignee: nayera,
    });

    const again = await ingestWhatsAppMessage(toOwned({ wamid: 'wamid.second', sentAt: LATER }));

    expect(again).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await conversation(first.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
    });
    expect(await holders(first.conversationId)).toMatchObject({ accountable: ali, assignee: ali });
    expect((await ownership(first.conversationId)).slice(1)).toEqual([
      {
        type: 'accountable_changed',
        actorAgentId: null,
        actorLabel: 'number_owner',
        data: { from: nayera, to: ali, channelId, reason: 'reopened_after_handover' },
      },
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'number_owner',
        data: { to: ali, reason: 'number_owner', channelId },
      },
    ]);
  });

  it('reopens a ticket as it was when the number has not changed hands', async () => {
    const nayera = await person('Nayera Mohamed');
    const bob = await person('Bob Supervisor');
    await ownedPhone(nayera);

    const first = await ingestWhatsAppMessage(toOwned());
    // A supervisor gave it to somebody else before it was resolved.
    await setStatus(first.conversationId, 'Resolved', { assigneeAgentId: bob });

    await ingestWhatsAppMessage(toOwned({ wamid: 'wamid.second', sentAt: LATER }));

    expect(await conversation(first.conversationId)).toMatchObject({ status: 'Open' });
    expect(await holders(first.conversationId)).toMatchObject({
      accountable: nayera,
      assignee: bob,
    });
    expect((await ownership(first.conversationId)).map((e) => e.type)).toEqual(['assigned']);
  });

  // Read before the transaction, the owner was the one the handover was about
  // to replace, and the ticket landed after the handover had collected the
  // number's tickets: left with somebody who no longer has the phone.
  it('stamps a message arriving mid-handover with the owner the handover leaves', async () => {
    const admin = await person('Mona Admin', { role: 'admin' });
    const nayera = await person('Nayera Mohamed');
    const ali = await person('Ali Nasser');
    const channelId = await ownedPhone(nayera);

    const hold = holdNextTransaction('after');
    const handover = handOverNumber({
      channelId,
      toAgentId: ali,
      actor: { id: admin, label: 'Mona Admin' },
    });
    await hold.atHold;

    const arriving = ingestWhatsAppMessage(toOwned());
    await untilWaitingOnALock(db);
    hold.release();
    const [, result] = await Promise.all([handover, arriving]);

    expect(await holders(result.conversationId)).toMatchObject({
      accountable: ali,
      assignee: ali,
    });
  });

  // An open ticket's accountability moves only in a handover, which moves it
  // in the same transaction as the number; a message arriving on it afterwards
  // finds nothing to correct. Here the column is changed behind the
  // handover's back, to show the message would not have corrected it anyway.
  it('continues an open ticket without changing whose it is', async () => {
    const nayera = await person('Nayera Mohamed');
    const ali = await person('Ali Nasser');
    const bob = await person('Bob Supervisor');
    const channelId = await ownedPhone(nayera);

    const first = await ingestWhatsAppMessage(toOwned());
    await db
      .update(conversations)
      .set({ assigneeAgentId: bob })
      .where(eq(conversations.id, first.conversationId));
    await db.update(channels).set({ ownerAgentId: ali }).where(eq(channels.id, channelId));

    const again = await ingestWhatsAppMessage(toOwned({ wamid: 'wamid.second', sentAt: LATER }));

    expect(again).toMatchObject({ conversationId: first.conversationId });
    expect(await holders(first.conversationId)).toMatchObject({
      accountable: nayera,
      assignee: bob,
    });
    expect((await ownership(first.conversationId)).map((e) => e.type)).toEqual(['assigned']);
  });
});

/**
 * A 190 on a status webhook, explained on the reply it refused.
 *
 * The webhook names no credential, and every one used to be explained as
 * META_PAGE_ACCESS_TOKEN's — so a stored credential's expiry sent somebody to
 * Render to replace a token that was fine, while the number stayed dead until
 * a reconnect nobody was told to make.
 */
describe('applyWhatsAppStatus, for an expired token', () => {
  const EXPIRED =
    '190: Error validating access token: Session has expired on Tuesday, 18-Aug-26 04:00:00 PDT.';

  async function account(wabaId: string, tokenEnvVar: string | null = null) {
    const [row] = await db
      .insert(whatsappAccounts)
      .values({ name: `ShipBlu ${wabaId}`, wabaId, tokenEnvVar, isDefault: true })
      .returning({ id: whatsappAccounts.id, wabaId: whatsappAccounts.wabaId });
    return row!;
  }

  async function storeCredential(target: { id: string; wabaId: string }) {
    await db.transaction((tx) =>
      storeBusinessToken(tx, {
        accountId: target.id,
        wabaId: target.wabaId,
        token: 'EAAGm0PX4ZCpsBAstatusTestToken0123456789',
        inspection: null,
        businessId: null,
        actor: null,
      }),
    );
  }

  /** A reply `send_whatsapp` sent, recording `meta` as it does, then refused with a 190. */
  async function refusedReply(meta: Record<string, unknown>): Promise<string | null> {
    const { conversationId } = await ingestWhatsAppMessage(inbound());
    await db.insert(messages).values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      bodyText: 'It leaves the hub this afternoon.',
      channelMessageId: 'wamid.reply-1',
      deliveryStatus: 'sent',
      meta,
    });

    const applied = await applyWhatsAppStatus({
      wamid: 'wamid.reply-1',
      status: 'failed',
      at: LATER,
      recipientId: CUSTOMER,
      error: EXPIRED,
      conversationExpiresAt: null,
    });
    expect(applied).toBe(true);

    const [row] = await db
      .select({ deliveryStatus: messages.deliveryStatus, deliveryError: messages.deliveryError })
      .from(messages)
      .where(eq(messages.channelMessageId, 'wamid.reply-1'));
    expect(row!.deliveryStatus).toBe('failed');
    expect(row!.deliveryError).toContain('Session has expired');
    return row!.deliveryError;
  }

  it('sends a stored credential to a reconnect, and nowhere near the shared token', async () => {
    const egypt = await account('102290129340398');
    await storeCredential(egypt);

    const explained = await refusedReply({
      phoneNumberId: SUPPORT_NUMBER,
      whatsappAccountId: egypt.id,
    });

    expect(explained).toContain('reconnected through Meta');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN');
  });

  it('names the variable the account sends with', async () => {
    const saudi = await account('102290129340399', 'WHATSAPP_TOKEN_SAUDI');

    const explained = await refusedReply({
      phoneNumberId: SUPPORT_NUMBER,
      whatsappAccountId: saudi.id,
    });

    expect(explained).toContain('WHATSAPP_TOKEN_SAUDI');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN');
  });

  it('finds the account through the number on a reply recorded before the account was', async () => {
    await storeCredential(await account('102290129340398'));

    expect(await refusedReply({ phoneNumberId: SUPPORT_NUMBER })).toContain(
      'reconnected through Meta',
    );
  });

  it('names the shared token when it is the one the send used', async () => {
    // No business account at all: the send resolved none, and authenticated
    // with META_PAGE_ACCESS_TOKEN.
    expect(await refusedReply({ phoneNumberId: SUPPORT_NUMBER })).toContain(
      'META_PAGE_ACCESS_TOKEN is expired',
    );
  });

  /**
   * The account the send recorded is gone. The number now resolves to another
   * one, with a stored credential — which is not what sent this reply, so
   * naming it would send somebody to reconnect a number that works.
   */
  it('says it cannot tell when the account the send recorded is gone', async () => {
    const gone = await account('102290129340397', 'WHATSAPP_TOKEN_OLD');
    await db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, gone.id));
    await storeCredential(await account('102290129340398'));

    const explained = await refusedReply({
      phoneNumberId: SUPPORT_NUMBER,
      whatsappAccountId: gone.id,
    });

    expect(explained).toContain('can no longer be told');
    expect(explained).not.toContain('reconnected through Meta');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN is expired');
  });

  it('says it cannot tell for a reply that recorded neither account nor number', async () => {
    const explained = await refusedReply({});

    expect(explained).toContain('can no longer be told');
    expect(explained).not.toContain('META_PAGE_ACCESS_TOKEN is expired');
  });
});
