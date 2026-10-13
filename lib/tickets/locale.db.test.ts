import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { requesterLocale } from './locale';

/**
 * The query half of `requesterLocale`, which `locale.test.ts` cannot reach:
 * which message decides the language an unattended sender writes in.
 */

withCleanDatabase();

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

describe('requesterLocale', () => {
  // `[reacted 🙏]` is seven Latin letters: read as the customer's words, it
  // would answer an Arabic customer in English for thanking us.
  it('reads the customer’s last words past a reaction', async () => {
    const id = await ticket('whatsapp');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: new Date('2026-10-01T10:05:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // The rows that carry no `whatsappType` at all are the ones a careless
  // spelling of that rule would drop, and every ticket would read English.
  it('still reads a message with no WhatsApp type', async () => {
    const id = await ticket('email');
    await db.insert(messages).values({
      conversationId: id,
      direction: 'inbound',
      bodyText: 'الشحنة وصلت مكسورة',
    });

    expect(await requesterLocale(id)).toBe('ar');
  });
});
