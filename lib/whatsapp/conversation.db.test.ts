import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { lastInboundPhoneNumberId, sendingNumberFor } from './conversation';

/**
 * The number a reply goes out from is the one the customer last wrote on —
 * the half of Meta's (number, customer) window that `last_customer_message_at`
 * does not say. So it is read off the same message that column is: a reaction
 * moves neither.
 */

withCleanDatabase();

const NUMBER_A = '100000000000001';
const NUMBER_B = '100000000000002';

async function chat(): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('sendingNumberFor', () => {
  it('answers from the number the customer last wrote on, not the one they last reacted on', async () => {
    const id = await chat();
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'Where is it?',
        meta: { whatsappType: 'text', phoneNumberId: NUMBER_A },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '[reacted 👍]',
        meta: { whatsappType: 'reaction', phoneNumberId: NUMBER_B },
        createdAt: new Date('2026-10-01T10:05:00Z'),
      },
    ]);

    expect(await sendingNumberFor(id, null)).toBe(NUMBER_A);
  });

  // The same lookup explains a failed send (`applyWhatsAppStatus`), so the two
  // cannot disagree about which number the customer wrote to.
  it('is the number a failed send is compared against, and says nothing without one', async () => {
    const id = await chat();
    expect(await lastInboundPhoneNumberId(id)).toBeNull();

    await db.insert(messages).values({
      conversationId: id,
      direction: 'inbound',
      bodyText: '[reacted 👍]',
      meta: { whatsappType: 'reaction', phoneNumberId: NUMBER_B },
    });
    expect(await lastInboundPhoneNumberId(id)).toBeNull();
  });

  it('still reads a number off a row that is not a WhatsApp message at all', async () => {
    const id = await chat();
    await db.insert(messages).values({
      conversationId: id,
      direction: 'inbound',
      bodyText: 'Where is it?',
      meta: { phoneNumberId: NUMBER_A },
    });

    expect(await sendingNumberFor(id, null)).toBe(NUMBER_A);
  });
});
