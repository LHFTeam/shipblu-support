import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import type {
  NormalisedHistoryChunk,
  NormalisedHistoryMessage,
  NormalisedInboundMessage,
} from '@/lib/whatsapp/types';
import { ingestWhatsAppMessage } from './ingest-whatsapp';
import {
  applyWhatsAppContactSync,
  attachHistoryMedia,
  ingestWhatsAppHistoryChunk,
} from './ingest-whatsapp-history';

/**
 * A Business-app number's past, imported: what lands, what never runs, and
 * that a second delivery — or a live message the history overlaps — writes
 * nothing twice.
 */

withCleanDatabase();

const NUMBER = '106540352242922';
const BUSINESS = '15550783881';
const PABLO = '16505551234';
const ROSA = '12125557890';
const RECEIVED = new Date('2026-10-08T12:00:00Z');

async function coexistenceChannel(phoneNumberId = NUMBER) {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name: `Phone ${phoneNumberId}`,
      config: {
        phoneNumberId,
        coexistence: {
          onboardedAt: '2026-10-08T11:00:00.000Z',
          wabaId: '102290129340398',
          syncs: { history: { requestId: 'req-1', requestedAt: '2026-10-08T11:01:00.000Z' } },
        },
      },
    })
    .returning({ id: channels.id });
  return row!.id;
}

function message(
  wamid: string,
  customer: string,
  direction: 'inbound' | 'outbound',
  sentAt: string,
  overrides: Partial<NormalisedHistoryMessage> = {},
): NormalisedHistoryMessage {
  return {
    wamid,
    customer,
    direction,
    sentAt: new Date(sentAt),
    type: 'text',
    text: `${direction} ${wamid}`,
    mediaPlaceholder: false,
    location: null,
    replyToWamid: null,
    phoneStatus: 'READ',
    raw: { id: wamid, from: direction === 'outbound' ? BUSINESS : customer },
    ...overrides,
  };
}

function chunk(
  messages: NormalisedHistoryMessage[],
  overrides: Partial<NormalisedHistoryChunk> = {},
): NormalisedHistoryChunk {
  return {
    phoneNumberId: NUMBER,
    phase: 0,
    chunkOrder: 1,
    progress: 55,
    messages,
    declined: null,
    ...overrides,
  };
}

/** Meta's own example, as `parseWebhook` normalises it. */
const SAMPLE = () =>
  chunk([
    message('wamid.p1', PABLO, 'outbound', '2025-02-10T23:42:35Z', {
      text: "Here's the info you requested!",
    }),
    message('wamid.p2', PABLO, 'outbound', '2025-02-10T23:42:50Z', {
      type: 'media_placeholder',
      text: '[media]',
      mediaPlaceholder: true,
      phoneStatus: 'PLAYED',
    }),
    message('wamid.p3', PABLO, 'inbound', '2025-02-10T23:42:50Z', { text: 'Thanks!' }),
    message('wamid.r1', ROSA, 'outbound', '2025-02-10T23:42:50Z', {
      text: 'Thanks for your order!',
      phoneStatus: 'DELIVERED',
    }),
  ]);

async function imported() {
  return db
    .select({
      id: conversations.id,
      externalId: conversations.externalId,
      sourceSystem: conversations.sourceSystem,
      channelId: conversations.channelId,
      category: ticketStatuses.category,
      subject: conversations.subject,
      createdAt: conversations.createdAt,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      lastAgentMessageAt: conversations.lastAgentMessageAt,
      firstRespondedAt: conversations.firstRespondedAt,
      resolvedAt: conversations.resolvedAt,
      firstResponseDueAt: conversations.firstResponseDueAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.sourceSystem, 'import'))
    .orderBy(asc(conversations.externalId));
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.channelMessageId));
}

async function historySlot(channelId: string) {
  const [row] = await db
    .select({ config: channels.config })
    .from(channels)
    .where(eq(channels.id, channelId));
  return parseCoexistence(row!.config)?.syncs.history;
}

describe('ingestWhatsAppHistoryChunk', () => {
  it('files each thread as one resolved import, both sides, and starts nothing', async () => {
    const channelId = await coexistenceChannel();

    const result = await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED);

    expect(result).toEqual({ skipped: null, threads: 2, created: 2, inserted: 4, duplicates: 0 });

    const [rosa, pablo] = await imported(); // by external id: Rosa's number sorts first
    expect(pablo).toMatchObject({
      externalId: `whatsapp:history:${NUMBER}:${PABLO}`,
      channelId,
      category: 'resolved',
      // The customer's own words, not the business's opener.
      subject: 'Thanks!',
      createdAt: new Date('2025-02-10T23:42:35Z'),
      lastMessageAt: new Date('2025-02-10T23:42:50Z'),
      // Every column a live decision reads stays empty.
      lastCustomerMessageAt: null,
      lastAgentMessageAt: null,
      firstRespondedAt: null,
      resolvedAt: null,
      firstResponseDueAt: null,
    });
    expect(rosa).toMatchObject({ category: 'resolved', subject: 'Thanks for your order!' });

    const rows = await messagesOf(pablo!.id);
    expect(rows.map((row) => [row.channelMessageId, row.direction, row.deliveryStatus])).toEqual([
      ['wamid.p1', 'outbound', 'read'],
      ['wamid.p2', 'outbound', 'read'],
      ['wamid.p3', 'inbound', 'delivered'],
    ]);
    expect(rows[1]).toMatchObject({
      sourceSystem: 'import',
      externalId: 'wamid.p2',
      authorAgentId: null,
      authorContactId: null,
      toAddresses: [PABLO],
      fromAddress: BUSINESS,
      bodyText: '[media]',
      meta: {
        history: true,
        echo: true,
        echoSource: 'business_app',
        mediaPlaceholder: true,
        phoneStatus: 'PLAYED',
      },
    });
    expect(rows[2]!.authorContactId).not.toBeNull();

    // No download, no categorising, no linking, no automation: no job at all.
    expect(await db.select({ type: jobs.type }).from(jobs)).toEqual([]);
    const events = await db
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, pablo!.id));
    expect(events).toEqual([{ type: 'history_imported' }]);

    expect(await historySlot(channelId)).toMatchObject({
      requestId: 'req-1',
      chunks: 1,
      progressByPhase: { '0': 55 },
      lastReceivedAt: RECEIVED.toISOString(),
    });
  });

  it('writes no ticket and no message the second time a chunk is processed', async () => {
    await coexistenceChannel();
    await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED);

    const again = await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED);

    expect(again).toEqual({ skipped: null, threads: 2, created: 0, inserted: 0, duplicates: 4 });
    expect(await imported()).toHaveLength(2);
    expect(await db.select({ id: messages.id }).from(messages)).toHaveLength(4);
  });

  it('gathers a thread spread over phases into one conversation, whatever order they arrive in', async () => {
    const channelId = await coexistenceChannel();
    await ingestWhatsAppHistoryChunk(
      chunk([message('wamid.new', PABLO, 'inbound', '2025-02-10T10:00:00Z')], { progress: 100 }),
      RECEIVED,
    );

    await ingestWhatsAppHistoryChunk(
      chunk([message('wamid.old', PABLO, 'inbound', '2024-11-02T10:00:00Z')], {
        phase: 1,
        progress: 40,
      }),
      RECEIVED,
    );
    // A late chunk of phase 0 at a lower figure: progress never goes back.
    await ingestWhatsAppHistoryChunk(
      chunk([message('wamid.mid', PABLO, 'outbound', '2025-02-09T10:00:00Z')], { progress: 30 }),
      RECEIVED,
    );

    const [only, ...rest] = await imported();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      createdAt: new Date('2024-11-02T10:00:00Z'),
      lastMessageAt: new Date('2025-02-10T10:00:00Z'),
    });
    expect((await messagesOf(only!.id)).map((row) => row.channelMessageId)).toEqual([
      'wamid.old',
      'wamid.mid',
      'wamid.new',
    ]);
    expect(await historySlot(channelId)).toMatchObject({
      chunks: 3,
      progressByPhase: { '0': 100, '1': 40 },
    });
  });

  it('leaves a message the number delivered live where it is, and opens nothing for it alone', async () => {
    await coexistenceChannel();
    const live = await ingestWhatsAppMessage({
      wamid: 'wamid.p3',
      from: PABLO,
      phoneNumberId: NUMBER,
      profileName: 'Pablo',
      sentAt: new Date('2026-10-08T11:30:00Z'),
      type: 'text',
      text: 'Thanks!',
      media: null,
      location: null,
      replyToWamid: null,
      raw: { id: 'wamid.p3' },
    } satisfies NormalisedInboundMessage);

    const result = await ingestWhatsAppHistoryChunk(
      chunk([message('wamid.p3', PABLO, 'inbound', '2026-10-08T11:30:00Z')]),
      RECEIVED,
    );

    expect(result).toMatchObject({ created: 0, inserted: 0, duplicates: 1 });
    expect(await imported()).toEqual([]);
    const [row] = await db
      .select({ conversationId: messages.conversationId, sourceSystem: messages.sourceSystem })
      .from(messages)
      .where(eq(messages.channelMessageId, 'wamid.p3'));
    expect(row).toEqual({ conversationId: live.conversationId, sourceSystem: 'native' });
  });

  it('never continues an import: the customer writing again opens a live ticket of its own', async () => {
    await coexistenceChannel();
    await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED);
    const [, pablo] = await imported();

    const live = await ingestWhatsAppMessage({
      wamid: 'wamid.live',
      from: PABLO,
      phoneNumberId: NUMBER,
      profileName: 'Pablo',
      sentAt: RECEIVED,
      type: 'text',
      text: 'Is my order out yet?',
      media: null,
      location: null,
      replyToWamid: null,
      raw: { id: 'wamid.live' },
    });

    expect(live.createdConversation).toBe(true);
    expect(live.conversationId).not.toBe(pablo!.id);
    const [, after] = await imported();
    expect(after).toMatchObject({ category: 'resolved', lastCustomerMessageAt: null });
  });

  it('skips a number not connected through coexistence, writing nothing', async () => {
    await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'Plain', config: { phoneNumberId: NUMBER } });

    expect(await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED)).toEqual({
      skipped: 'not_coexistence',
    });
    expect(await db.select({ id: conversations.id }).from(conversations)).toEqual([]);
    expect(await db.select({ id: contacts.id }).from(contacts)).toEqual([]);
  });

  it('records a business declining to share, and imports nothing', async () => {
    const channelId = await coexistenceChannel();

    const result = await ingestWhatsAppHistoryChunk(
      chunk([], {
        declined: { code: 2593109, message: 'History sync is turned off by the business' },
        phase: null,
        progress: null,
      }),
      RECEIVED,
    );

    expect(result).toEqual({ skipped: 'declined' });
    expect(await historySlot(channelId)).toMatchObject({
      requestId: 'req-1',
      declined: { at: RECEIVED.toISOString(), code: 2593109 },
    });
    expect(await imported()).toEqual([]);
  });
});

describe('attachHistoryMedia', () => {
  it('names the file on the imported placeholder, and fetches nothing', async () => {
    await coexistenceChannel();
    await ingestWhatsAppHistoryChunk(SAMPLE(), RECEIVED);

    const attached = await attachHistoryMedia({
      wamid: 'wamid.p2',
      phoneNumberId: NUMBER,
      text: '[image] Black Prince echeveria',
      media: {
        mediaId: '24230790383178626',
        mimeType: 'image/jpeg',
        sha256: null,
        filename: null,
        isVoice: false,
      },
    });

    expect(attached).toBe(true);
    const [row] = await db
      .select({ bodyText: messages.bodyText, meta: messages.meta })
      .from(messages)
      .where(eq(messages.channelMessageId, 'wamid.p2'));
    expect(row).toMatchObject({
      bodyText: '[image] Black Prince echeveria',
      meta: {
        history: true,
        mediaPlaceholder: { mimeType: 'image/jpeg', filename: null, isVoice: false },
      },
    });
    expect(await db.select({ type: jobs.type }).from(jobs)).toEqual([]);
  });

  it('touches no live message that happens to share the wamid', async () => {
    expect(
      await attachHistoryMedia({
        wamid: 'wamid.unknown',
        phoneNumberId: NUMBER,
        text: '[image]',
        media: {
          mediaId: '1',
          mimeType: 'image/jpeg',
          sha256: null,
          filename: null,
          isVoice: false,
        },
      }),
    ).toBe(false);
  });
});

describe('applyWhatsAppContactSync', () => {
  const sync = (overrides = {}) => ({
    phoneNumberId: NUMBER,
    phone: PABLO,
    name: 'Pablo Morales' as string | null,
    action: 'add' as const,
    at: new Date('2025-02-12T00:43:44Z'),
    ...overrides,
  });

  async function identityOf(phone: string) {
    const [row] = await db
      .select({ name: contacts.name, displayName: contactIdentities.displayName })
      .from(contactIdentities)
      .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
      .where(
        and(eq(contactIdentities.channel, 'whatsapp'), eq(contactIdentities.identifier, phone)),
      );
    return row ?? null;
  }

  it('adds a contact named from the address book, and counts it', async () => {
    const channelId = await coexistenceChannel();

    expect(await applyWhatsAppContactSync(sync(), RECEIVED)).toBe('applied');

    expect(await identityOf(PABLO)).toEqual({
      name: 'Pablo Morales',
      displayName: 'Pablo Morales',
    });
    const [row] = await db
      .select({ config: channels.config })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(parseCoexistence(row!.config)?.syncs.contacts).toMatchObject({
      received: 1,
      lastReceivedAt: RECEIVED.toISOString(),
    });
  });

  it('never renames a contact somebody already named', async () => {
    await coexistenceChannel();
    await applyWhatsAppContactSync(sync({ name: 'Pablo M.' }), RECEIVED);
    await db.update(contacts).set({ name: 'Pablo (VIP, Maadi)' });

    await applyWhatsAppContactSync(sync({ name: 'Pablo Morales' }), RECEIVED);

    expect(await identityOf(PABLO)).toEqual({
      name: 'Pablo (VIP, Maadi)',
      displayName: 'Pablo Morales',
    });
  });

  it('changes nothing on a removal, for an unconnected number, or for an entry with no number', async () => {
    expect(await applyWhatsAppContactSync(sync(), RECEIVED)).toBe('not_coexistence');
    await coexistenceChannel();
    expect(await applyWhatsAppContactSync(sync({ action: 'remove', name: null }), RECEIVED)).toBe(
      'removed',
    );
    expect(await applyWhatsAppContactSync(sync({ phone: 'Office' }), RECEIVED)).toBe(
      'not_a_number',
    );
    expect(await db.select({ id: contacts.id }).from(contacts)).toEqual([]);
  });
});
