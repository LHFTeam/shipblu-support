import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversationEvents, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { untilWaitingOnALock } from '@/lib/testing/hold-transaction';
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
      { id: ticket.id },
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
      { id: ticket.id },
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
      { id: ticket.id },
      { actorLabel: 'inbound_email', reason: 'customer_replied' },
    );

    expect(reopened).toBe(false);
    expect(await ticketRow(ticket.id)).toEqual(before);
    expect(await db.$count(conversationEvents)).toBe(0);
  });

  // Every caller decides from a read with no lock. An agent's reopen landing
  // after it left the stale answer to reopen an open ticket: a second
  // `reopened` event naming the resolver, and a reopen counted against them,
  // for a customer who wrote to a ticket already back in the queue.
  it.each(['Open', 'Pending'])(
    'leaves a ticket put back %s since the caller read it as it is',
    async (name) => {
      const ticket = await resolvedTicket();
      await db
        .update(conversations)
        .set({ statusId: await statusId(name), resolvedAt: null })
        .where(eq(conversations.id, ticket.id));
      const before = await ticketRow(ticket.id);

      const reopened = await reopenResolved(
        db,
        { id: ticket.id },
        { actorLabel: 'inbound_email', reason: 'customer_replied' },
      );

      expect(reopened).toBe(false);
      expect(await ticketRow(ticket.id)).toEqual(before);
      expect(await db.$count(conversationEvents)).toBe(0);
    },
  );

  // The agent's reopen still in flight: the status is read under the ticket's
  // lock, which waits for it, so the answer is the one it commits.
  it('waits for a reopen in flight and leaves the ticket to it', async () => {
    const ticket = await resolvedTicket();
    const open = await statusId('Open');
    const other = postgres(process.env.TEST_DATABASE_URL!, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => (wrote = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let agent: Promise<unknown> | undefined;
    let customer: Promise<boolean> | undefined;
    let queued = false;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      agent = other.begin(async (tx) => {
        await tx`update conversations set status_id = ${open}, resolved_at = null
                 where id = ${ticket.id}`;
        wrote();
        await gate;
      });
      await written;
      customer = reopenResolved(
        db,
        { id: ticket.id },
        { actorLabel: 'inbound_email', reason: 'customer_replied' },
      );
      queued = await untilWaitingOnALock(db, { rowLockIn: '^\\s*select\\M' });
      release();
      outcomes = await Promise.allSettled([agent, customer]);
    } finally {
      release();
      await Promise.allSettled([agent, customer]);
      await other.end();
    }

    expect(queued).toBe(true);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      { status: 'fulfilled', value: false },
    ]);
    expect((await ticketRow(ticket.id))?.reopenCount).toBe(2);
    expect(await db.$count(conversationEvents)).toBe(0);
  });

  // Closed since the caller read it: still reopened, as it always was. The
  // caller has chosen this ticket for the message, and left closed it would
  // sit on a ticket in no queue. Counted from the row, not the caller's read.
  it('reopens a ticket closed since the caller read it, counting from the row', async () => {
    const ticket = await resolvedTicket();
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed'), reopenCount: 5 })
      .where(eq(conversations.id, ticket.id));

    const reopened = await reopenResolved(
      db,
      { id: ticket.id },
      { actorLabel: 'inbound_email', reason: 'customer_replied' },
    );

    expect(reopened).toBe(true);
    expect(await ticketRow(ticket.id)).toMatchObject({
      statusId: await statusId('Open'),
      reopenCount: 6,
    });
  });
});
