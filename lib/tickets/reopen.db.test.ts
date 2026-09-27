import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversationEvents, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { reopenResolved } from './reopen';

/**
 * The reopen every inbound path shares. The path tests pin it through each
 * caller; these pin the helper's own two answers, one of which no path test
 * reaches: a database with no open status, where the ticket stays resolved.
 */

withCleanDatabase();

const RESOLVED_AT = new Date('2026-09-20T10:30:00Z');

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

/** A ticket resolved by an agent, reopened twice before. */
async function resolvedTicket() {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      statusId: await statusId('Resolved'),
      requesterContactId: contact!.id,
      reopenCount: 2,
      resolvedAt: RESOLVED_AT,
      resolvedByAgentId: agent!.id,
    })
    .returning({ id: conversations.id });
  return { id: ticket!.id, resolver: agent!.id };
}

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      statusId: conversations.statusId,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row;
}

describe('reopenResolved', () => {
  it('opens the ticket, and records who had resolved it on the event', async () => {
    const ticket = await resolvedTicket();

    const reopened = await reopenResolved(
      db,
      { id: ticket.id, reopenCount: 2 },
      { actorLabel: 'inbound_email', reason: 'customer_replied' },
    );

    expect(reopened).toBe(true);
    expect(await ticketRow(ticket.id)).toEqual({
      statusId: await statusId('Open'),
      reopenCount: 3,
      resolvedAt: null,
      // Left in place, so the event can read it.
      resolvedByAgentId: ticket.resolver,
    });
    expect(
      await db
        .select({
          type: conversationEvents.type,
          actorLabel: conversationEvents.actorLabel,
          data: conversationEvents.data,
        })
        .from(conversationEvents),
    ).toEqual([
      {
        type: 'reopened',
        actorLabel: 'inbound_email',
        data: { reason: 'customer_replied', resolvedBy: ticket.resolver },
      },
    ]);
  });

  it('carries the reason it is given', async () => {
    const ticket = await resolvedTicket();

    await reopenResolved(
      db,
      { id: ticket.id, reopenCount: 2 },
      { actorLabel: 'webchat', reason: 'visitor_replied' },
    );

    const [event] = await db.select({ data: conversationEvents.data }).from(conversationEvents);
    expect(event?.data).toMatchObject({ reason: 'visitor_replied' });
  });

  it('leaves the ticket resolved, and writes nothing, when there is no open status', async () => {
    const ticket = await resolvedTicket();
    const before = await ticketRow(ticket.id);
    await db.delete(ticketStatuses).where(eq(ticketStatuses.category, 'open'));

    const reopened = await reopenResolved(
      db,
      { id: ticket.id, reopenCount: 2 },
      { actorLabel: 'inbound_email', reason: 'customer_replied' },
    );

    expect(reopened).toBe(false);
    expect(await ticketRow(ticket.id)).toEqual(before);
    expect(await db.$count(conversationEvents)).toBe(0);
  });
});
