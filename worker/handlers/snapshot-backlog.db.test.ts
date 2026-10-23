import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agentBacklogSnapshots,
  agents,
  contacts,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import { agentLoad } from '@/lib/reports/live';
import { withCleanDatabase } from '@/lib/testing/db';
import { snapshotBacklog } from './snapshot-backlog';

/**
 * The hourly backlog sample against Postgres. Its one claim worth a database
 * is that it is the live board taken at a moment: what each person holds by
 * the assignee, as the capacity check counts it, and what is breached by whom
 * it counts against — so a sample read next week and the board read today say
 * the same thing about the same tickets.
 */

withCleanDatabase();

async function ticket(
  values: Partial<typeof conversations.$inferInsert> & { status: string },
): Promise<void> {
  const { status, ...rest } = values;
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, status));
  await db
    .insert(conversations)
    .values({ channel: 'whatsapp', statusId: row!.id, requesterContactId: contact!.id, ...rest });
}

describe('snapshotBacklog', () => {
  it('samples what each person holds, and the breaches that count against them', async () => {
    const [nayera, bob] = await db
      .insert(agents)
      .values([
        { name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' },
        { name: 'Bob', email: 'bob@shipblu.test', role: 'agent' },
      ])
      .returning({ id: agents.id });

    // On Nayera's number and held by Bob, past its target.
    await ticket({
      status: 'Open',
      accountableAgentId: nayera!.id,
      assigneeAgentId: bob!.id,
      firstResponseBreached: true,
    });
    // On Nayera's number, waiting on the customer, held by nobody, past its target.
    await ticket({ status: 'Pending', accountableAgentId: nayera!.id, resolutionBreached: true });
    // Bob's, on a team number, past its target.
    await ticket({ status: 'Pending', assigneeAgentId: bob!.id, resolutionBreached: true });

    await snapshotBacklog();

    const sampled = await db
      .select({
        agentId: agentBacklogSnapshots.agentId,
        openCount: agentBacklogSnapshots.openCount,
        pendingCount: agentBacklogSnapshots.pendingCount,
        breachedCount: agentBacklogSnapshots.breachedCount,
      })
      .from(agentBacklogSnapshots);
    const sample = (id: string) => sampled.find((row) => row.agentId === id);

    expect(sample(nayera!.id)).toMatchObject({ openCount: 0, pendingCount: 0, breachedCount: 2 });
    expect(sample(bob!.id)).toMatchObject({ openCount: 1, pendingCount: 1, breachedCount: 1 });

    // The same answer the board gives for every active agent, the baseline's included.
    const board = await agentLoad();
    expect(sampled.map((row) => [row.agentId, row.breachedCount]).sort()).toEqual(
      board.map((row) => [row.id, row.breached]).sort(),
    );
  });
});
