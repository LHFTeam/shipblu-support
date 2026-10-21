import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channelOwnerChanges,
  channels,
  contacts,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * What the database itself holds about a number's owner, whatever code path
 * wrote the row: `channels_owner_only_whatsapp` from db/sql/003, and the
 * foreign-key shapes that decide what survives an agent or a channel being
 * deleted.
 *
 * `handOverNumber` refuses the same things before it writes, and has its own
 * tests. These are the half that also holds for a hand-written UPDATE, which is
 * the reason the CHECK exists.
 */

withCleanDatabase();

async function agent(name: string): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test` })
    .returning({ id: agents.id });
  return row!.id;
}

async function channel(
  type: 'whatsapp' | 'whatsapp_bot' | 'email',
  name: string,
  ownerAgentId: string | null = null,
): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type, name, config: {}, ownerAgentId })
    .returning({ id: channels.id });
  return row!.id;
}

/** The constraint's refusal, as postgres.js reports it underneath drizzle's wrapper. */
const refusedByCheck = {
  cause: { code: '23514', constraint_name: 'channels_owner_only_whatsapp' },
};

describe('channels_owner_only_whatsapp', () => {
  it('lets a whatsapp number have an owner, and any channel have none', async () => {
    const nayera = await agent('Nayera Mohamed');

    const owned = await channel('whatsapp', 'Nayera Mohamed', nayera);
    await channel('whatsapp_bot', 'Second bot');
    await channel('email', 'Support mailbox');

    const [row] = await db
      .select({ owner: channels.ownerAgentId })
      .from(channels)
      .where(eq(channels.id, owned));
    expect(row!.owner).toBe(nayera);
  });

  it('refuses an owner on the bot or a mailbox, inserted or updated', async () => {
    const nayera = await agent('Nayera Mohamed');

    await expect(channel('whatsapp_bot', 'Second bot', nayera)).rejects.toMatchObject(
      refusedByCheck,
    );

    const mailbox = await channel('email', 'Support mailbox');
    await expect(
      db.update(channels).set({ ownerAgentId: nayera }).where(eq(channels.id, mailbox)),
    ).rejects.toMatchObject(refusedByCheck);
  });

  it('refuses turning an owned number into another type', async () => {
    const nayera = await agent('Nayera Mohamed');
    const owned = await channel('whatsapp', 'Nayera Mohamed', nayera);

    // No form edits a channel's type, so this is exactly the hand-written
    // UPDATE the constraint is for.
    await expect(
      db.update(channels).set({ type: 'whatsapp_bot' }).where(eq(channels.id, owned)),
    ).rejects.toMatchObject(refusedByCheck);
  });
});

describe('what survives a deletion', () => {
  it('forgets a deleted agent on the number and the ticket, and keeps their name on the record', async () => {
    const nayera = await agent('Nayera Mohamed');
    const admin = await agent('Ali Nasser');
    const number = await channel('whatsapp', 'Nayera Mohamed', nayera);

    const [status] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const [ticket] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        channelId: number,
        statusId: status!.id,
        requesterContactId: contact!.id,
        accountableAgentId: nayera,
        assigneeAgentId: nayera,
      })
      .returning({ id: conversations.id });

    await db.insert(channelOwnerChanges).values({
      channelId: number,
      channelName: 'Nayera Mohamed',
      displayNumber: '+20 12 78707918',
      toAgentId: nayera,
      toLabel: 'Nayera Mohamed',
      changedByAgentId: admin,
      changedByLabel: 'Ali Nasser',
      ticketsMoved: 1,
    });

    await db.delete(agents).where(eq(agents.id, nayera));

    const [numberRow] = await db
      .select({ owner: channels.ownerAgentId })
      .from(channels)
      .where(eq(channels.id, number));
    expect(numberRow!.owner).toBeNull();

    const [ticketRow] = await db
      .select({ accountable: conversations.accountableAgentId })
      .from(conversations)
      .where(eq(conversations.id, ticket!.id));
    expect(ticketRow!.accountable).toBeNull();

    expect(await db.select().from(channelOwnerChanges)).toEqual([
      expect.objectContaining({
        toAgentId: null,
        toLabel: 'Nayera Mohamed',
        changedByAgentId: admin,
        changedByLabel: 'Ali Nasser',
      }),
    ]);
  });

  it('keeps the history of a number whose channel row is deleted', async () => {
    const nayera = await agent('Nayera Mohamed');
    const number = await channel('whatsapp', 'Nayera Mohamed', nayera);

    await db.insert(channelOwnerChanges).values({
      channelId: number,
      channelName: 'Nayera Mohamed',
      toAgentId: nayera,
      toLabel: 'Nayera Mohamed',
    });

    await db.delete(channels).where(eq(channels.id, number));

    expect(await db.select().from(channelOwnerChanges)).toEqual([
      expect.objectContaining({ channelId: number, channelName: 'Nayera Mohamed' }),
    ]);
  });
});
