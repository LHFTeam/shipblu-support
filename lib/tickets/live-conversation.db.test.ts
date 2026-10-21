import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, contacts, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  findLiveConversation,
  findNewestConversation,
  lockThread,
  type ThreadKey,
} from './live-conversation';

/**
 * Which of a contact's conversations counts as their live one. The WhatsApp and
 * widget path tests reach two of these cases; the rest — another channel,
 * another contact, a deleted or merged-away ticket, the newest winning, and
 * which of our numbers a ticket is on — are pinned only here.
 */

withCleanDatabase();

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

async function contact(): Promise<string> {
  const [row] = await db.insert(contacts).values({ name: 'Amira' }).returning({ id: contacts.id });
  return row!.id;
}

/** A WhatsApp number of ours, as its `channels` row. */
async function number(name: string): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name, config: { phoneNumberId: `pnid-${name}` } })
    .returning({ id: channels.id });
  return row!.id;
}

/** WhatsApp tickets filed under no row — what every fixture here is unless it names one. */
const NO_ROW: ThreadKey = { channel: 'whatsapp', channelId: null };
const on = (channelId: string): ThreadKey => ({ channel: 'whatsapp', channelId });

async function ticket(
  requesterContactId: string,
  overrides: Partial<typeof conversations.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'whatsapp',
      statusId: await statusId('Open'),
      requesterContactId,
      lastMessageAt: new Date('2026-09-20T10:00:00Z'),
      ...overrides,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('findLiveConversation', () => {
  it('finds the contact’s open conversation on the channel', async () => {
    const amira = await contact();
    const id = await ticket(amira);

    expect(await findLiveConversation(amira, NO_ROW)).toMatchObject({
      id,
      statusCategory: 'open',
      reopenCount: 0,
    });
  });

  it('finds a resolved one, which a reply reopens', async () => {
    const amira = await contact();
    const id = await ticket(amira, { statusId: await statusId('Resolved') });

    expect(await findLiveConversation(amira, NO_ROW)).toMatchObject({
      id,
      statusCategory: 'resolved',
    });
  });

  it('does not continue a closed one', async () => {
    const amira = await contact();
    await ticket(amira, { statusId: await statusId('Closed') });

    expect(await findLiveConversation(amira, NO_ROW)).toBeNull();
  });

  it('answers about the newest conversation only, even when that one is closed', async () => {
    const amira = await contact();
    await ticket(amira, { lastMessageAt: new Date('2026-09-19T10:00:00Z') });
    await ticket(amira, {
      statusId: await statusId('Closed'),
      lastMessageAt: new Date('2026-09-20T10:00:00Z'),
    });

    // The older open one is not fallen back to: closing the newest is the
    // team saying the matter is over.
    expect(await findLiveConversation(amira, NO_ROW)).toBeNull();
  });

  it('keeps to the channel and the contact it is asked about', async () => {
    const amira = await contact();
    const omar = await contact();
    await ticket(amira, { channel: 'webchat' });
    await ticket(omar);

    expect(await findLiveConversation(amira, NO_ROW)).toBeNull();
  });

  it('skips a deleted conversation and one merged into another', async () => {
    const amira = await contact();
    const survivor = await ticket(amira, { lastMessageAt: new Date('2026-09-18T10:00:00Z') });
    await ticket(amira, { deletedAt: new Date('2026-09-21T10:00:00Z') });
    await ticket(amira, { mergedIntoId: survivor });

    expect((await findLiveConversation(amira, NO_ROW))?.id).toBe(survivor);
  });
});

/**
 * A WhatsApp ticket is the customer's conversation with one of our numbers, so
 * the same customer writing to two numbers has two — each its own live one,
 * and neither visible from the other's key.
 */
describe('which of our numbers a WhatsApp ticket is on', () => {
  it('does not continue one number’s ticket for a message to another', async () => {
    const amira = await contact();
    const a = await number('a');
    const b = await number('b');
    const onA = await ticket(amira, { channelId: a });

    expect((await findLiveConversation(amira, on(a)))?.id).toBe(onA);
    expect(await findLiveConversation(amira, on(b))).toBeNull();
  });

  // The null arm is not a wildcard: a ticket filed before its number had a row
  // would otherwise absorb this customer's messages to every number.
  it('keeps tickets with no row and tickets with one apart, both ways', async () => {
    const amira = await contact();
    const a = await number('a');
    const loose = await ticket(amira);

    expect(await findLiveConversation(amira, on(a))).toBeNull();

    const onA = await ticket(amira, {
      channelId: a,
      lastMessageAt: new Date('2026-09-21T10:00:00Z'),
    });
    expect((await findLiveConversation(amira, NO_ROW))?.id).toBe(loose);
    expect((await findLiveConversation(amira, on(a)))?.id).toBe(onA);
  });

  it('answers about the newest conversation per number, so a closed one hides only its own', async () => {
    const amira = await contact();
    const a = await number('a');
    const b = await number('b');
    const onB = await ticket(amira, {
      channelId: b,
      lastMessageAt: new Date('2026-09-19T10:00:00Z'),
    });
    await ticket(amira, {
      channelId: a,
      statusId: await statusId('Closed'),
      lastMessageAt: new Date('2026-09-20T10:00:00Z'),
    });

    expect(await findLiveConversation(amira, on(a))).toBeNull();
    expect((await findLiveConversation(amira, on(b)))?.id).toBe(onB);
  });

  it('finds the newest conversation, import included, on the number asked about only', async () => {
    const amira = await contact();
    const a = await number('a');
    const b = await number('b');
    const imported = await ticket(amira, {
      channelId: b,
      sourceSystem: 'import',
      externalId: 'whatsapp:history:pnid-b:201001234567',
      statusId: await statusId('Resolved'),
      lastMessageAt: new Date('2026-09-19T10:00:00Z'),
    });
    await ticket(amira, { channelId: a, lastMessageAt: new Date('2026-09-20T10:00:00Z') });

    expect(await findNewestConversation(amira, on(b))).toEqual({
      id: imported,
      number: expect.any(Number),
      imported: true,
    });
    // And not live on B: an import is a record, never continued.
    expect(await findLiveConversation(amira, on(b))).toBeNull();
  });
});

/**
 * The lock is what lets ingest find the live conversation and create one when
 * there is none without two deliveries each creating one.
 */
describe('lockThread', () => {
  it('holds a second transaction on the same thread until the first commits, and no other', async () => {
    const amira = await contact();
    const a = await number('a');
    const b = await number('b');
    const order: string[] = [];

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let signal!: () => void;
    const locked = new Promise<void>((resolve) => (signal = resolve));

    const first = db.transaction(async (tx) => {
      await lockThread(tx, amira, on(a));
      signal();
      await held;
      order.push('first');
    });
    await locked;

    const second = db.transaction(async (tx) => {
      await lockThread(tx, amira, on(a));
      order.push('second');
    });

    // The same customer on another number, and the bot, wait for nobody.
    await db.transaction(async (tx) => {
      await lockThread(tx, amira, on(b));
      await lockThread(tx, amira, { channel: 'whatsapp_bot' });
      order.push('other');
    });

    release();
    await Promise.all([first, second]);

    expect(order).toEqual(['other', 'first', 'second']);
  });
});
