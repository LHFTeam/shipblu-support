import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversationEvents, conversations, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { changeStatus, type StatusTarget } from './status';

/**
 * The status write both console paths share. What it must get right is which
 * stamps each category writes and clears: a resolve records who resolved,
 * moving back to Open keeps that record for the reopen to read, and a close is
 * dated by `closedAt` alone.
 */

withCleanDatabase();

async function status(name: string): Promise<StatusTarget> {
  const [row] = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      category: ticketStatuses.category,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row;
}

async function openTicket() {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      statusId: (await status('Open')).id,
      requesterContactId: contact!.id,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, agentId: agent!.id };
}

async function stamps(id: string) {
  const [row] = await db
    .select({
      statusId: conversations.statusId,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      closedAt: conversations.closedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function statusEvents(id: string) {
  return db
    .select({
      type: conversationEvents.type,
      actor: conversationEvents.actorAgentId,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'status_changed')),
    );
}

describe('changeStatus', () => {
  it('resolves: stamps when and by whom, and records the event', async () => {
    const { id, agentId } = await openTicket();
    const resolved = await status('Resolved');

    await changeStatus(agentId, id, resolved);

    const row = await stamps(id);
    expect(row).toMatchObject({
      statusId: resolved.id,
      resolvedByAgentId: agentId,
      closedAt: null,
    });
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect(await statusEvents(id)).toEqual([
      {
        type: 'status_changed',
        actor: agentId,
        data: { to: 'Resolved', category: 'resolved' },
      },
    ]);
    // A resolved status stops the clock, so the SLA hook ran after the write.
    expect(
      await db
        .select({ id: conversationEvents.id })
        .from(conversationEvents)
        .where(
          and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'sla_paused')),
        ),
    ).toHaveLength(1);
  });

  it('names the path on the event when it is not the picker', async () => {
    const { id, agentId } = await openTicket();

    await changeStatus(agentId, id, await status('Resolved'), 'reply_and_resolve');

    expect((await statusEvents(id))[0]!.data).toEqual({
      to: 'Resolved',
      category: 'resolved',
      via: 'reply_and_resolve',
    });
  });

  it('back to Open clears the resolve time but keeps who resolved it', async () => {
    const { id, agentId } = await openTicket();
    await changeStatus(agentId, id, await status('Resolved'));

    await changeStatus(agentId, id, await status('Open'));

    expect(await stamps(id)).toMatchObject({
      resolvedAt: null,
      resolvedByAgentId: agentId,
      closedAt: null,
    });
  });

  it('closes: dated by closedAt, with no resolve stamps', async () => {
    const { id, agentId } = await openTicket();

    await changeStatus(agentId, id, await status('Closed'));

    const row = await stamps(id);
    expect(row).toMatchObject({ resolvedAt: null, resolvedByAgentId: null });
    expect(row.closedAt).toBeInstanceOf(Date);
  });
});
