import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversationWatchers,
  conversations,
  groupMembers,
  groups,
  routingDecisions,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { setAccepting } from '@/lib/assignment/presence';
import { settleRouting } from '@/lib/routing/apply';
import { ROUTING_GRACE_MS } from '@/lib/routing/hold';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';
import { assignSweep } from './assign-sweep';

/**
 * The assignment sweep against Postgres: which tickets the reclaim pass takes
 * back and the event it leaves; and what the sweep does with a ticket held for
 * the router — nothing while the hold lasts, then assign it, or escalate it,
 * in the group routing left it in.
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

  // Review on #243: a supervisor taking over an idle park, so the next keypress
  // does not undo it, changes why the agent is away and not whether. The wait
  // is for how long they have been unavailable, so it keeps running.
  it('keeps measuring from the switch when only the reason for the away changes', async () => {
    const agentId = await agent({
      presence: 'online',
      lastSeenAt: new Date(),
      isAcceptingTickets: false,
      acceptingOffReason: 'idle',
      acceptingChangedAt: minutesAgo(30),
    });
    const id = await assignedTicket(agentId);

    expect(await setAccepting(agentId, false, 'supervisor')).toBe(true);
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

/**
 * A WhatsApp number's owner answers from the phone with the console closed, so
 * the presence the reclaim pass measures says nothing about them. Their own
 * tickets stay with them while they are active; everything else about an owned
 * ticket is reclaimed as before.
 */
describe('assignSweep: reclaiming on a number that belongs to somebody', () => {
  async function owner(state: AgentState): Promise<string> {
    const [row] = await db
      .insert(agents)
      .values({ name: 'Nayera', email: 'nayera@shipblu.test', ...state })
      .returning({ id: agents.id });
    return row!.id;
  }

  async function ownedNumber(ownerAgentId: string): Promise<string> {
    const [row] = await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'Nayera Mohamed', ownerAgentId, config: {} })
      .returning({ id: channels.id });
    return row!.id;
  }

  it('never takes an owned ticket from its owner while they are active', async () => {
    const nayera = await owner({ presence: 'offline', lastSeenAt: minutesAgo(30) });
    const channelId = await ownedNumber(nayera);
    const id = await assignedTicket(nayera, {
      channel: 'whatsapp',
      channelId,
      accountableAgentId: nayera,
    });

    await assignSweep();

    expect(await outcome(id)).toEqual({ assigneeAgentId: nayera, reclaimed: [] });
  });

  // Reclaimed, and then the rota: the group has nobody in it, so it waits.
  it('takes it back from an owner who has been deactivated', async () => {
    const nayera = await owner({
      presence: 'offline',
      lastSeenAt: minutesAgo(30),
      isActive: false,
    });
    const channelId = await ownedNumber(nayera);
    const id = await assignedTicket(nayera, {
      channel: 'whatsapp',
      channelId,
      accountableAgentId: nayera,
    });

    await assignSweep();

    expect(await outcome(id)).toEqual({
      assigneeAgentId: null,
      reclaimed: [{ from: nayera, afterMins: WAIT_MINS }],
    });
  });

  // Somebody else holding the owner's ticket is measured like anybody — and
  // once it is back in the queue, the same run hands it to the owner.
  it('takes an owned ticket back from somebody else, and gives it to the owner', async () => {
    const nayera = await owner({ presence: 'offline', lastSeenAt: minutesAgo(30) });
    const omar = await agent({ presence: 'offline', lastSeenAt: minutesAgo(30) });
    const channelId = await ownedNumber(nayera);
    const id = await assignedTicket(omar, {
      channel: 'whatsapp',
      channelId,
      accountableAgentId: nayera,
    });

    await assignSweep();

    expect(await outcome(id)).toEqual({
      assigneeAgentId: nayera,
      reclaimed: [{ from: omar, afterMins: WAIT_MINS }],
    });
  });
});

/**
 * A ticket held for the router (`plans/ticket-category-routing.md`, decision
 * 5) is unassigned by design and may be about to leave its group, so the sweep
 * neither assigns nor escalates it until the hold is over — and the hold's
 * grace is what keeps a sweep at the window's end from racing the router's
 * move. Once the grace runs out on a settle that never came, the sweep is the
 * safety valve, and the late settle records `taken` and moves nothing.
 */
describe('assignSweep: a ticket held for the router', () => {
  /** A team that takes tickets now: round robin, any hour, one member online. */
  async function desk(name: string, member: string) {
    const [group] = await db
      .insert(groups)
      .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
      .returning({ id: groups.id });
    const [agentRow] = await db
      .insert(agents)
      .values({
        name: member,
        email: `${member.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`,
        presence: 'online',
        lastSeenAt: new Date(),
      })
      .returning({ id: agents.id });
    await db.insert(groupMembers).values({ groupId: group!.id, agentId: agentRow!.id });
    return { groupId: group!.id, agentId: agentRow!.id };
  }

  /**
   * Customer Care, where the inbox files everything, and Merchant Care, where
   * Sales routes; the inbox routes by category.
   */
  async function routedInbox() {
    const care = await desk('Customer Care', 'Omar Care');
    const merchants = await desk('Merchant Care', 'Mona Merchant');
    const [channel] = await db
      .insert(channels)
      .values({
        type: 'email',
        name: 'Support inbox',
        config: {},
        routingMode: 'category',
        defaultGroupId: care.groupId,
      })
      .returning({ id: channels.id });
    const [sales] = await db
      .update(ticketCategories)
      .set({ routeGroupId: merchants.groupId })
      .where(eq(ticketCategories.key, 'sales'))
      .returning({ id: ticketCategories.id });
    return { care, merchants, channelId: channel!.id, salesId: sales!.id };
  }

  /**
   * A ticket the inbox opened in Customer Care, unassigned, its window closing
   * at `windowEndsAt`, its routing row `holding` as `beginRouting` leaves it.
   */
  async function heldTicket(
    inbox: Awaited<ReturnType<typeof routedInbox>>,
    windowEndsAt: Date,
    values: Partial<typeof conversations.$inferInsert> = {},
  ) {
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
        channel: 'email',
        channelId: inbox.channelId,
        groupId: inbox.care.groupId,
        statusId: status!.id,
        requesterContactId: contact!.id,
        lastCustomerMessageAt: new Date(),
        routingWindowEndsAt: windowEndsAt,
        ...values,
      })
      .returning({ id: conversations.id });
    await db.insert(routingDecisions).values({
      conversationId: row!.id,
      channelId: inbox.channelId,
      shadow: false,
      stage: 'holding',
      fromGroupId: inbox.care.groupId,
      windowEndsAt,
      startedAt: new Date(windowEndsAt.getTime() - 5 * MINUTE),
    });
    return row!.id;
  }

  async function ticketState(id: string) {
    const [row] = await db
      .select({ groupId: conversations.groupId, assignee: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  async function eventsOf(id: string, type: string) {
    const rows = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
      .orderBy(asc(conversationEvents.createdAt));
    return rows;
  }

  async function routingOf(id: string) {
    const [row] = await db
      .select({
        stage: routingDecisions.stage,
        outcome: routingDecisions.outcome,
        toGroupId: routingDecisions.toGroupId,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    return row!;
  }

  /** Resolves once `count` sessions are waiting on a lock; fails the test if they never are. */
  async function untilWaitingOnLocks(count: number): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const [{ waiting }] = (await db.execute(
        sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      )) as unknown as [{ waiting: number }];
      if (waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`fewer than ${count} sessions ever waited on a lock`);
  }

  const inMinutes = (mins: number) => minutesAgo(-mins);

  it('leaves a held ticket unassigned, and assigns it once the hold is over', async () => {
    const inbox = await routedInbox();
    const id = await heldTicket(inbox, inMinutes(5));

    await assignSweep();

    expect(await ticketState(id)).toEqual({ groupId: inbox.care.groupId, assignee: null });
    // Not a skip on the timeline every five minutes.
    expect(await eventsOf(id, 'assignment_skipped')).toEqual([]);

    // Whatever ended the hold assigns the ticket itself, best-effort; the
    // sweep is the second chance when that failed.
    await db
      .update(conversations)
      .set({ routingDecidedAt: new Date() })
      .where(eq(conversations.id, id));
    await assignSweep();

    expect(await ticketState(id)).toEqual({
      groupId: inbox.care.groupId,
      assignee: inbox.care.agentId,
    });
    expect(await eventsOf(id, 'assigned')).toEqual([
      { actorLabel: 'assign_sweep', data: { to: inbox.care.agentId, strategy: 'round_robin' } },
    ]);
  });

  // The window's end, with Jev's Sales answer on the ticket: the sweep runs
  // while `settle_routing` is part-way through. Inside the router's phase one
  // the ticket is still held, so the sweep leaves it; once the hold has ended
  // it is in Merchant Care, and the sweep and the router's own assignment
  // both reach for it — one of them takes it, from Merchant Care.
  it('assigns a ticket settled at the window’s end once, in the group it was routed to', async () => {
    const inbox = await routedInbox();
    const id = await heldTicket(inbox, new Date(), { categoryId: inbox.salesId });

    // Phase one has moved the ticket and not committed.
    const phaseOne = holdNextTransaction('after');
    const settling = settleRouting(id);
    await phaseOne.atHold;

    await assignSweep();
    expect(await ticketState(id)).toEqual({ groupId: inbox.care.groupId, assignee: null });

    // Phase three ends the hold; once it commits, a lock taken behind it keeps
    // the router's assignment and the sweep's waiting side by side.
    const phaseThree = holdNextTransaction('after');
    phaseOne.release();
    await phaseThree.atHold;
    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    const locker = db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, id))
        .for('update');
      lockTaken();
      await lockHeld;
    });
    await untilWaitingOnLocks(1);
    phaseThree.release();
    await taken;

    const sweeping = assignSweep();
    await untilWaitingOnLocks(2);
    releaseLock();
    await locker;
    await sweeping;

    await expect(settling).resolves.toBe('decided');
    expect(await ticketState(id)).toEqual({
      groupId: inbox.merchants.groupId,
      assignee: inbox.merchants.agentId,
    });
    expect((await eventsOf(id, 'assigned')).map((event) => event.data)).toEqual([
      { to: inbox.merchants.agentId, strategy: 'round_robin' },
    ]);
    expect(await routingOf(id)).toEqual({
      stage: 'decided',
      outcome: 'category',
      toGroupId: inbox.merchants.groupId,
    });
    expect(await eventsOf(id, 'routed')).toHaveLength(1);
  });

  // A `settle_routing` stuck in the queue: the grace is the valve, so the
  // sweep assigns the ticket where it is, and the settle that finally runs
  // finds somebody holding it — `taken` — and moves nothing, Sales or not.
  it('assigns a ticket whose settle never came once the grace is over, and the late settle records taken', async () => {
    const inbox = await routedInbox();
    const id = await heldTicket(inbox, new Date(Date.now() - ROUTING_GRACE_MS - MINUTE), {
      categoryId: inbox.salesId,
    });

    await assignSweep();

    expect(await ticketState(id)).toEqual({
      groupId: inbox.care.groupId,
      assignee: inbox.care.agentId,
    });

    await expect(settleRouting(id)).resolves.toBe('decided');

    expect(await ticketState(id)).toEqual({
      groupId: inbox.care.groupId,
      assignee: inbox.care.agentId,
    });
    expect(await routingOf(id)).toEqual({
      stage: 'decided',
      outcome: 'taken',
      toGroupId: inbox.care.groupId,
    });
    expect((await eventsOf(id, 'routed')).map((event) => event.data)).toEqual([
      expect.objectContaining({ outcome: 'taken', moved: false, to: inbox.care.groupId }),
    ]);
    expect(await eventsOf(id, 'assigned')).toHaveLength(1);
    expect(await eventsOf(id, 'group_changed')).toEqual([]);
  });

  // Held, a ticket is in a group it may be about to leave: escalated, the
  // group's lead would watch another team's ticket, and the once-ever dedupe
  // would stop it escalating in the team it went to.
  it('does not escalate a held ticket, and escalates it once the hold is over', async () => {
    const inbox = await routedInbox();
    const lead = inbox.care.agentId;
    // Manual, so the sweep never assigns it and only escalation acts.
    await db
      .update(groups)
      .set({ assignmentStrategy: 'manual', escalateToAgentId: lead, escalateAfterMins: 1 })
      .where(eq(groups.id, inbox.care.groupId));
    const id = await heldTicket(inbox, inMinutes(5), { createdAt: minutesAgo(30) });

    const watchers = async () =>
      (
        await db
          .select({ agentId: conversationWatchers.agentId })
          .from(conversationWatchers)
          .where(eq(conversationWatchers.conversationId, id))
      ).map((row) => row.agentId);

    await assignSweep();

    expect(await eventsOf(id, 'assignment_escalated')).toEqual([]);
    expect(await watchers()).toEqual([]);

    await db
      .update(conversations)
      .set({ routingDecidedAt: new Date() })
      .where(eq(conversations.id, id));
    await assignSweep();
    await assignSweep();

    expect(await eventsOf(id, 'assignment_escalated')).toEqual([
      { actorLabel: 'assign_sweep', data: { to: lead, afterMins: 1 } },
    ]);
    expect(await watchers()).toEqual([lead]);
  });
});
