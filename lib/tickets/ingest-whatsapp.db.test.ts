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
  whatsappAccounts,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeBusinessToken } from '@/lib/whatsapp/credentials';
import type { NormalisedEcho, NormalisedInboundMessage } from '@/lib/whatsapp/types';
import { applyWhatsAppStatus, ingestWhatsAppEcho, ingestWhatsAppMessage } from './ingest-whatsapp';
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
