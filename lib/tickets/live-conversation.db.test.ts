import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { findLiveConversation } from './live-conversation';

/**
 * Which of a contact's conversations counts as their live one. The WhatsApp and
 * widget path tests reach two of these cases; the rest — another channel,
 * another contact, a deleted or merged-away ticket, and the newest winning — are
 * pinned only here.
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

    expect(await findLiveConversation(amira, 'whatsapp')).toMatchObject({
      id,
      statusCategory: 'open',
      reopenCount: 0,
    });
  });

  it('finds a resolved one, which a reply reopens', async () => {
    const amira = await contact();
    const id = await ticket(amira, { statusId: await statusId('Resolved') });

    expect(await findLiveConversation(amira, 'whatsapp')).toMatchObject({
      id,
      statusCategory: 'resolved',
    });
  });

  it('does not continue a closed one', async () => {
    const amira = await contact();
    await ticket(amira, { statusId: await statusId('Closed') });

    expect(await findLiveConversation(amira, 'whatsapp')).toBeNull();
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
    expect(await findLiveConversation(amira, 'whatsapp')).toBeNull();
  });

  it('keeps to the channel and the contact it is asked about', async () => {
    const amira = await contact();
    const omar = await contact();
    await ticket(amira, { channel: 'webchat' });
    await ticket(omar);

    expect(await findLiveConversation(amira, 'whatsapp')).toBeNull();
  });

  it('skips a deleted conversation and one merged into another', async () => {
    const amira = await contact();
    const survivor = await ticket(amira, { lastMessageAt: new Date('2026-09-18T10:00:00Z') });
    await ticket(amira, { deletedAt: new Date('2026-09-21T10:00:00Z') });
    await ticket(amira, { mergedIntoId: survivor });

    expect((await findLiveConversation(amira, 'whatsapp'))?.id).toBe(survivor);
  });
});
