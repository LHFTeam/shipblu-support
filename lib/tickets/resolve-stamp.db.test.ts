import { eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, contacts, conversations, ticketStatuses } from '@/db/schema';
import { computeDay, reportingContext, totalsOf } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { runTimeAutomations } from '@/worker/handlers/run-time-automations';
import { changeStatus, type StatusTarget } from './status';

/**
 * The resolve stamp across the paths that close a ticket, end to end: the
 * seeded rule's sweep, an agent's close, and the rollup that counts a day's
 * resolutions from the stamp. §6.98 was all three at once — the rule closed
 * every resolved ticket after 72 hours, the close cleared the stamp, and the
 * resolve's day lost the resolution the next time it was recomputed.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();

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

async function agent(): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: `omar-${crypto.randomUUID()}@shipblu.test` })
    .returning({ id: agents.id });
  return row!.id;
}

async function ticket(statusName = 'Open'): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      statusId: (await status(statusName)).id,
      requesterContactId: contact!.id,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function row(id: string) {
  const [found] = await db
    .select({
      category: ticketStatuses.category,
      resolvedAt: sql<string | null>`${conversations.resolvedAt}::text`,
      resolvedByAgentId: conversations.resolvedByAgentId,
      closedAt: conversations.closedAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  return found!;
}

/** Moves a ticket's resolve back in time, as if it had been resolved then. */
async function resolvedSince(id: string, when: Date): Promise<string> {
  await db.update(conversations).set({ resolvedAt: when }).where(eq(conversations.id, id));
  return (await row(id)).resolvedAt!;
}

describe('the resolve stamp through a close', () => {
  it("survives the seeded rule's close after three days", async () => {
    const agentId = await agent();
    const id = await ticket();
    await changeStatus(agentId, id, await status('Resolved'));
    const resolvedAt = await resolvedSince(id, new Date(Date.now() - 100 * 3_600_000));

    await runTimeAutomations();

    const closed = await row(id);
    expect(closed.category).toBe('closed');
    expect(closed.resolvedAt).toBe(resolvedAt);
    // The rule closes; it does not take the resolution from who made it.
    expect(closed.resolvedByAgentId).toBe(agentId);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it('is never stamped by a close: a conversation filed resolved with none stays without one', async () => {
    // A WhatsApp Business app conversation or a copied history is filed in a
    // resolved status with no stamp, because nobody resolved it.
    const id = await ticket('Resolved');

    await changeStatus(await agent(), id, await status('Closed'));

    expect(await row(id)).toMatchObject({ category: 'closed', resolvedAt: null });
  });

  it("keeps a closed resolution on its resolve's day when the day is recomputed", async () => {
    const agentId = await agent();
    const resolvedThenClosed = await ticket();
    await changeStatus(agentId, resolvedThenClosed, await status('Resolved'));
    await resolvedSince(resolvedThenClosed, at('2026-10-13T10:00'));
    await changeStatus(agentId, resolvedThenClosed, await status('Closed'));
    // Closed without being resolved: no resolution, on any day.
    await changeStatus(agentId, await ticket(), await status('Closed'));

    const day = totalsOf(await computeDay('2026-10-13', await reportingContext()));

    expect(day.ticketsResolved).toBe(1);
    expect(day.resolutionCount).toBe(1);
  });
});
