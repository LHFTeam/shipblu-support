import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversationEvents,
  conversations,
  groups,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { assignSweep } from './assign-sweep';

/**
 * The reclaim pass of the assignment sweep, against Postgres: which tickets it
 * takes back, and the event it leaves.
 *
 * The sweep takes its clock from `new Date()`, so an agent is placed in time by
 * their timestamps, relative to now. The group reclaims after ten minutes.
 */

withCleanDatabase();

const MINUTE = 60_000;
const WAIT_MINS = 10;

function minutesAgo(mins: number): Date {
  return new Date(Date.now() - mins * MINUTE);
}

type AgentState = Partial<
  Pick<
    typeof agents.$inferInsert,
    | 'presence'
    | 'lastSeenAt'
    | 'isAcceptingTickets'
    | 'acceptingOffReason'
    | 'acceptingChangedAt'
    | 'isActive'
  >
>;

async function agent(state: AgentState): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', ...state })
    .returning({ id: agents.id });
  return row!.id;
}

async function assignedTicket(
  assigneeAgentId: string,
  values: Partial<typeof conversations.$inferInsert> = {},
): Promise<string> {
  const [group] = await db
    .insert(groups)
    .values({ name: 'Returns', assignmentStrategy: 'round_robin', reclaimAfterMins: WAIT_MINS })
    .returning({ id: groups.id });
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
      channel: 'email',
      groupId: group!.id,
      assigneeAgentId,
      assignedAt: minutesAgo(60),
      lastCustomerMessageAt: minutesAgo(60),
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function outcome(id: string) {
  const [row] = await db
    .select({ assigneeAgentId: conversations.assigneeAgentId })
    .from(conversations)
    .where(eq(conversations.id, id));
  const reclaimed = await db
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, id),
        eq(conversationEvents.type, 'assignment_reclaimed'),
      ),
    );
  return { assigneeAgentId: row!.assigneeAgentId, reclaimed: reclaimed.map((e) => e.data) };
}

describe('assignSweep: reclaiming an unanswered ticket', () => {
  it('takes it back from an agent whose console went quiet longer ago than the wait', async () => {
    const agentId = await agent({ presence: 'offline', lastSeenAt: minutesAgo(30) });
    const id = await assignedTicket(agentId);

    await assignSweep();

    expect(await outcome(id)).toEqual({
      assigneeAgentId: null,
      reclaimed: [{ from: agentId, afterMins: WAIT_MINS }],
    });
  });

  it('leaves it with an agent who is connected and accepting', async () => {
    const agentId = await agent({ presence: 'online', lastSeenAt: new Date() });
    const id = await assignedTicket(agentId);

    await assignSweep();

    expect(await outcome(id)).toEqual({ assigneeAgentId: agentId, reclaimed: [] });
  });

  it('waits the full period after assignment, when the agent was already gone', async () => {
    const agentId = await agent({ presence: 'offline', lastSeenAt: minutesAgo(60) });
    const id = await assignedTicket(agentId, { assignedAt: minutesAgo(5) });

    await assignSweep();

    expect(await outcome(id)).toEqual({ assigneeAgentId: agentId, reclaimed: [] });
  });

  it('leaves a ticket the agent has already answered', async () => {
    const agentId = await agent({ presence: 'offline', lastSeenAt: minutesAgo(30) });
    const id = await assignedTicket(agentId, { lastAgentMessageAt: minutesAgo(40) });

    await assignSweep();

    expect(await outcome(id)).toEqual({ assigneeAgentId: agentId, reclaimed: [] });
  });

  // A console left open keeps beating `last_seen_at` every 25 seconds whether
  // or not its owner is accepting work, so the heartbeat says nothing about
  // when somebody became unavailable. The switch's own timestamp does.
  it('takes it back from an agent who went away longer ago than the wait, with the tab still open', async () => {
    const agentId = await agent({
      presence: 'online',
      lastSeenAt: new Date(),
      isAcceptingTickets: false,
      acceptingOffReason: 'self',
      acceptingChangedAt: minutesAgo(30),
    });
    const id = await assignedTicket(agentId);

    await assignSweep();

    expect(await outcome(id)).toEqual({
      assigneeAgentId: null,
      reclaimed: [{ from: agentId, afterMins: WAIT_MINS }],
    });
  });

  it('leaves it with an agent who went away more recently than the wait, with the tab still open', async () => {
    const agentId = await agent({
      presence: 'online',
      lastSeenAt: new Date(),
      isAcceptingTickets: false,
      acceptingOffReason: 'idle',
      acceptingChangedAt: minutesAgo(5),
    });
    const id = await assignedTicket(agentId);

    await assignSweep();

    expect(await outcome(id)).toEqual({ assigneeAgentId: agentId, reclaimed: [] });
  });
});
