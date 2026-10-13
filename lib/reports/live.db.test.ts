import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { todayByHour } from './live';

/**
 * The live report's hourly volume, the one figure on it counted from messages
 * rather than tickets — so the one that has to say for itself which rows are
 * traffic.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const NOW = DateTime.fromISO('2026-10-13T12:30', { zone: ZONE });

async function ticket(channel: 'whatsapp' | 'email'): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('todayByHour', () => {
  it('counts what was said, from either side, and neither side’s reactions', async () => {
    const chat = await ticket('whatsapp');
    const mail = await ticket('email');
    const at = (time: string) => DateTime.fromISO(`2026-10-13T${time}`, { zone: ZONE }).toJSDate();

    await db.insert(messages).values([
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: at('11:05'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: 'On its way',
        meta: { sendKind: 'text' },
        createdAt: at('11:10'),
      },
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at('11:12'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
        createdAt: at('11:15'),
      },
      // No `whatsappType` at all, as on every email: still traffic.
      { conversationId: mail, direction: 'inbound', bodyText: 'Refund?', createdAt: at('11:20') },
    ]);

    const hours = await todayByHour(ZONE, NOW.toJSDate());

    expect(hours.find((bucket) => bucket.hour === 11)).toEqual({
      hour: 11,
      inbound: 2,
      outbound: 1,
    });
  });
});
