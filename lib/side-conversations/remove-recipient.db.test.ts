import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  internalRecipients,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { removeInternalRecipient } from './remove-recipient';

/**
 * The Delete button on `/admin/recipients`. `side_conversations.recipient_id`
 * is `ON DELETE SET NULL`, so a delete that lands on a recipient a thread has
 * used blanks who was asked. These pin the three answers, and that the thread
 * keeps its recipient in the one that matters.
 */

withCleanDatabase();

async function recipient(name: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(internalRecipients)
    .values({ name, email: `${name.toLowerCase()}@shipblu.test`, kind: 'team', isActive })
    .returning({ id: internalRecipients.id });
  return row!.id;
}

/** A ticket with a side conversation addressed to `recipientId`. */
async function threadTo(recipientId: string): Promise<string> {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [ticket] = await db
    .insert(conversations)
    .values({ channel: 'email', statusId: status!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  const [side] = await db
    .insert(sideConversations)
    .values({
      conversationId: ticket!.id,
      subject: 'refund for 1212121212121',
      recipientId,
      toAddresses: ['finance@shipblu.test'],
    })
    .returning({ id: sideConversations.id });
  return side!.id;
}

async function recipientRow(id: string) {
  const [row] = await db
    .select({ isActive: internalRecipients.isActive })
    .from(internalRecipients)
    .where(eq(internalRecipients.id, id));
  return row;
}

describe('removeInternalRecipient', () => {
  it('deletes a recipient no thread has gone to', async () => {
    const id = await recipient('Finance');
    await threadTo(await recipient('Returns'));

    expect(await removeInternalRecipient(id)).toEqual({ outcome: 'deleted' });
    expect(await recipientRow(id)).toBeUndefined();
  });

  it('retires one a thread has gone to, and the thread keeps its recipient', async () => {
    const id = await recipient('Finance');
    const side = await threadTo(id);

    expect(await removeInternalRecipient(id)).toEqual({ outcome: 'retired' });
    expect(await recipientRow(id)).toEqual({ isActive: false });

    const [thread] = await db
      .select({ recipientId: sideConversations.recipientId })
      .from(sideConversations)
      .where(eq(sideConversations.id, side));
    expect(thread?.recipientId).toBe(id);
  });

  it('leaves one already deactivated as it is', async () => {
    const id = await recipient('Finance', false);
    await threadTo(id);

    expect(await removeInternalRecipient(id)).toEqual({ outcome: 'retired' });
    expect(await recipientRow(id)).toEqual({ isActive: false });
  });

  it('answers a recipient that is already gone without touching anything', async () => {
    const kept = await recipient('Finance');

    expect(await removeInternalRecipient('00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'gone',
    });
    expect(await recipientRow(kept)).toEqual({ isActive: true });
  });
});
