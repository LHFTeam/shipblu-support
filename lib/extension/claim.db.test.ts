import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { withCleanDatabase } from '@/lib/testing/db';
import { claimTicket } from './claim';
import { ticketShipments } from './tickets';

/**
 * "Take this ticket" lets an agent assign themselves a ticket they cannot yet
 * see, so its limits are the whole of what keeps it from being a way around
 * the visibility rule: unassigned only, a coexistence WhatsApp number only, and
 * a conditional update that leaves one owner when two agents press at once.
 */

withCleanDatabase();

async function agent(
  name: string,
  role: SessionAgent['role'] = 'agent',
  permissions: Record<string, boolean> = {},
): Promise<SessionAgent> {
  const [row] = await db
    .insert(agents)
    .values({ email: `${name}@shipblu.test`, name, role, permissions })
    .returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: row!.permissions,
    avatarUrl: null,
    avatarColor: null,
    isAcceptingTickets: true,
    acceptingOffReason: null,
    sessionIdleForMs: 0,
  };
}

async function channel(coexistence: boolean) {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      // Unique per call: `channels.name` is, and a test can make several.
      name: `${coexistence ? 'Nayera' : 'WhatsApp Support'} ${crypto.randomUUID()}`,
      config: coexistence
        ? {
            phoneNumberId: '111',
            coexistence: { onboardedAt: '2026-10-01T00:00:00Z', wabaId: 'W1', syncs: {} },
          }
        : { phoneNumberId: '222' },
    })
    .returning({ id: channels.id });
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: status!.id,
      channel: 'whatsapp',
      channelId: await channel(true),
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function assignee(conversationId: string) {
  const [row] = await db
    .select({ assigneeAgentId: conversations.assigneeAgentId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row!.assigneeAgentId;
}

describe('claimTicket', () => {
  it('assigns an unassigned coexistence ticket, which the agent can then read', async () => {
    const amal = await agent('amal');
    const id = await ticket();

    expect(await ticketShipments(amal, id)).toBeNull();
    expect(await claimTicket(amal, id)).toEqual({ kind: 'claimed' });

    expect(await assignee(id)).toBe(amal.id);
    expect(await ticketShipments(amal, id)).toEqual([]);
    const events = await db
      .select({ type: conversationEvents.type, actor: conversationEvents.actorAgentId })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id));
    expect(events).toEqual([{ type: 'assigned', actor: amal.id }]);
  });

  it('is a no-op the second time', async () => {
    const amal = await agent('amal');
    const id = await ticket();

    await claimTicket(amal, id);
    expect(await claimTicket(amal, id)).toEqual({ kind: 'already_yours' });
    expect(await db.select().from(conversationEvents)).toHaveLength(1);
  });

  it('never takes a ticket somebody holds, and names them', async () => {
    const amal = await agent('amal');
    const omar = await agent('omar');
    const id = await ticket({ assigneeAgentId: omar.id });

    expect(await claimTicket(amal, id)).toEqual({ kind: 'held', assigneeName: 'omar' });
    expect(await assignee(id)).toBe(omar.id);
  });

  it('leaves one owner when two agents press at once', async () => {
    const amal = await agent('amal');
    const omar = await agent('omar');
    const id = await ticket();

    const results = await Promise.all([claimTicket(amal, id), claimTicket(omar, id)]);

    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    const owner = await assignee(id);
    const loser = results.find((r) => r.kind === 'held');
    expect(loser).toEqual({ kind: 'held', assigneeName: owner === amal.id ? 'amal' : 'omar' });
  });

  it('answers a ticket on a number that is not coexistence as not found', async () => {
    const amal = await agent('amal');
    const id = await ticket({ channelId: await channel(false) });

    expect(await claimTicket(amal, id)).toEqual({ kind: 'not_found' });
    expect(await assignee(id)).toBeNull();
  });

  it('answers a deleted or merged ticket, and a malformed id, as not found', async () => {
    const amal = await agent('amal');
    const survivor = await ticket();
    const deleted = await ticket({ deletedAt: new Date() });
    const merged = await ticket({ mergedIntoId: survivor });

    expect(await claimTicket(amal, deleted)).toEqual({ kind: 'not_found' });
    expect(await claimTicket(amal, merged)).toEqual({ kind: 'not_found' });
    expect(await claimTicket(amal, 'nope')).toEqual({ kind: 'not_found' });
  });

  it('refuses an agent who may not set an assignee', async () => {
    const barred = await agent('barred', 'agent', { 'ticket.assign': false });
    const id = await ticket();

    expect((await claimTicket(barred, id)).kind).toBe('refused');
    expect(await assignee(id)).toBeNull();
  });
});
