import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, locations, sideConversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { removeLocation } from './remove';

/**
 * The Delete button on `/admin/locations`. Before this guard it deleted
 * whatever it was given, and the foreign key from `side_conversations` is
 * `ON DELETE SET NULL` — so deleting a hub a thread had asked succeeded and
 * quietly stripped the hub off that thread. These pin the three answers, and
 * that the thread keeps its hub in the one that matters.
 */

withCleanDatabase();

async function location(code: string, isActive = true): Promise<string> {
  const [row] = await db
    .insert(locations)
    .values({ name: `Hub ${code}`, code, email: `${code.toLowerCase()}@shipblu.test`, isActive })
    .returning({ id: locations.id });
  return row!.id;
}

/** A ticket with a side conversation addressed to `locationId`. */
async function threadTo(locationId: string): Promise<string> {
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
      subject: '1212121212121 || where is it',
      locationId,
      toAddresses: ['hub@shipblu.test'],
    })
    .returning({ id: sideConversations.id });
  return side!.id;
}

async function locationRow(id: string) {
  const [row] = await db
    .select({ isActive: locations.isActive })
    .from(locations)
    .where(eq(locations.id, id));
  return row;
}

describe('removeLocation', () => {
  it('deletes a location no thread has gone to', async () => {
    const id = await location('ALX-1');
    const other = await location('CAI-1');
    await threadTo(other);

    expect(await removeLocation(id)).toEqual({ outcome: 'deleted' });
    expect(await locationRow(id)).toBeUndefined();
  });

  it('retires one a thread has gone to, and the thread keeps its hub', async () => {
    const id = await location('ALX-1');
    const side = await threadTo(id);
    await threadTo(id);

    expect(await removeLocation(id)).toEqual({
      outcome: 'retired',
      name: 'Hub ALX-1',
      code: 'ALX-1',
      threads: 2,
      wasActive: true,
    });
    expect(await locationRow(id)).toEqual({ isActive: false });

    const [thread] = await db
      .select({ locationId: sideConversations.locationId })
      .from(sideConversations)
      .where(eq(sideConversations.id, side));
    expect(thread?.locationId).toBe(id);
  });

  it('leaves one already closed as it is, and says so', async () => {
    const id = await location('ALX-1', false);
    await threadTo(id);

    expect(await removeLocation(id)).toMatchObject({ outcome: 'retired', wasActive: false });
    expect(await locationRow(id)).toEqual({ isActive: false });
  });

  it('answers a location that is already gone without touching anything', async () => {
    const kept = await location('CAI-1');

    expect(await removeLocation('00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'gone',
    });
    expect(await locationRow(kept)).toEqual({ isActive: true });
  });
});
