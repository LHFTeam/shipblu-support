import { readFileSync } from 'node:fs';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `008_whatsapp_channel_backfill.sql`, run as `db/migrate.ts` runs it: the
 * file's own text, executed, and executed again.
 *
 * The CI replay proves the statement plans and survives a second run on an
 * empty database, where it matches nothing. This is the half that needs rows:
 * that it picks the number a ticket was really on, and that a replay — which
 * happens on every deploy — never moves a ticket a second time.
 */

withCleanDatabase();

const backfill = readFileSync(
  new URL('./008_whatsapp_channel_backfill.sql', import.meta.url),
  'utf8',
);

const run = () => db.execute(sql.raw(backfill));

const SUPPORT = '838961722630554';
const PHONE = '106540352242922';
const BOT = '128318316834446';

async function openStatus(): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return row!.id;
}

async function number(
  name: string,
  phoneNumberId: string,
  extra: Partial<typeof channels.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name, config: { phoneNumberId }, ...extra })
    .returning({ id: channels.id });
  return row!.id;
}

async function ticket(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'whatsapp',
      statusId: await openStatus(),
      requesterContactId: contact!.id,
      lastMessageAt: new Date('2026-09-20T10:00:00Z'),
      ...overrides,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

let sequence = 0;

/** A WhatsApp message on a ticket, as ingest stores one: the number in `meta.phoneNumberId`. */
async function message(
  conversationId: string,
  phoneNumberId: string,
  at: string,
  shape: { direction?: 'inbound' | 'outbound'; whatsappType?: string } = {},
) {
  await db.insert(messages).values({
    conversationId,
    direction: shape.direction ?? 'inbound',
    kind: 'reply',
    bodyText: 'Where is my parcel?',
    channelMessageId: `wamid.${++sequence}`,
    meta: { whatsappType: shape.whatsappType ?? 'text', phoneNumberId },
    createdAt: new Date(`2026-09-20T${at}:00Z`),
  });
}

async function channelOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.channelId;
}

describe('008_whatsapp_channel_backfill.sql', () => {
  it('files a ticket with no row under the number its newest inbound message reached', async () => {
    const support = await number('WhatsApp Support', SUPPORT);
    const phone = await number('Nayera', PHONE);
    const id = await ticket();
    await message(id, SUPPORT, '09:00');
    await message(id, PHONE, '09:30');
    // Newer, but not what the customer wrote to: a reaction is filed on a
    // ticket rather than threading it, and our own reply is not their number.
    await message(id, SUPPORT, '10:00', { whatsappType: 'reaction' });
    await message(id, SUPPORT, '10:30', { direction: 'outbound' });

    await run();

    expect(await channelOf(id)).toBe(phone);
    expect(await channelOf(id)).not.toBe(support);
  });

  // Production's ticket #1 carries messages to the bot's number and the
  // support number. It is a support ticket, and goes to the support number.
  it('never files a ticket under the bot, even when its newest message reached the bot', async () => {
    const support = await number('WhatsApp Support', SUPPORT);
    const id = await ticket();
    await message(id, SUPPORT, '09:00');
    await message(id, BOT, '09:30');

    await run();

    expect(await channelOf(id)).toBe(support);
  });

  it('prefers an active row where two name the same number', async () => {
    await number('Retired', SUPPORT, {
      isActive: false,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const live = await number('WhatsApp Support', SUPPORT, {
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    const id = await ticket();
    await message(id, SUPPORT, '09:00');

    await run();

    expect(await channelOf(id)).toBe(live);
  });

  // The resolver threads only on active rows, so a ticket placed under an
  // inactive one is out of its customer's reach: their next message, still
  // filed under no row, would open another beside it, and every deploy would
  // strand one more.
  it('never places a ticket under an inactive row', async () => {
    await number('Retired', SUPPORT, { isActive: false });
    const id = await ticket();
    await message(id, SUPPORT, '09:00');

    await run();

    expect(await channelOf(id)).toBeNull();
  });

  // The support row exists, so each ticket below that names its number would be
  // placed there if the statement reached it.
  it('leaves alone what it cannot place, and what is already placed', async () => {
    await number('WhatsApp Support', SUPPORT);
    const phone = await number('Nayera', PHONE);
    const nowhere = await ticket();
    await message(nowhere, '100000000000001', '09:00');
    const silent = await ticket();
    const placed = await ticket({ channelId: phone });
    await message(placed, SUPPORT, '09:00');
    const bot = await ticket({ channel: 'whatsapp_bot' });
    await message(bot, SUPPORT, '09:00');

    await run();

    expect(await channelOf(nowhere)).toBeNull();
    expect(await channelOf(silent)).toBeNull();
    expect(await channelOf(placed)).toBe(phone);
    expect(await channelOf(bot)).toBeNull();
  });

  // Replayed after every migration, so a second run must write nothing — not
  // even the same value, which would still touch `updated_at` and wake every
  // console watching the ticket.
  it('changes nothing the second time', async () => {
    await number('WhatsApp Support', SUPPORT);
    await number('Nayera', PHONE);
    const moved = await ticket();
    await message(moved, PHONE, '09:00');
    const stays = await ticket();
    await message(stays, '100000000000001', '09:00');

    await run();
    const first = await snapshot();
    await run();

    expect(await snapshot()).toEqual(first);
    expect(first.find((row) => row.id === moved)?.channelId).not.toBeNull();
  });
});

async function snapshot() {
  return db
    .select({
      id: conversations.id,
      channelId: conversations.channelId,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .orderBy(asc(conversations.id));
}
