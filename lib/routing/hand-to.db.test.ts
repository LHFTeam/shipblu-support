import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  messages,
  routingDecisions,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { setConversationCategory } from '@/lib/categories/write';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';
import { routeNow, settleRouting, type RouteResult } from './apply';
import { handToRouteGroup, type HandToResult } from './hand-to';
import { ROUTING_GRACE_MS } from './hold';

/**
 * "Hand to <group>" against Postgres: after routing has decided a ticket and a
 * person has relabelled it, the hand-over moves it to the new category's
 * group, takes it off its holder and lands it with somebody there — recorded
 * as `group_changed`, `unassigned` and `assigned` — and every ticket it must
 * not touch is refused before anything is written.
 *
 * The groups keep no hours (`assignWithinHoursOnly: false`): the hand-over
 * assigns on the wall clock, and a group that keeps Cairo's would refuse at
 * night and at the weekend.
 */

withCleanDatabase();

const MINUTE = 60_000;

async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`,
      presence: 'online',
      lastSeenAt: new Date(),
      ...values,
    })
    .returning({ id: agents.id });
  return row!.id;
}

async function group(
  name: string,
  members: string[],
  values: Partial<typeof groups.$inferInsert> = {},
) {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false, ...values })
    .returning({ id: groups.id });
  if (members.length) {
    await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  }
  return row!.id;
}

/** A category routing to `routeGroupId` — the seeded one of that key, re-pointed, if any. */
async function category(key: string, routeGroupId: string | null) {
  const [row] = await db
    .insert(ticketCategories)
    .values({ key, labelEn: key, labelAr: key, routeGroupId })
    .onConflictDoUpdate({ target: ticketCategories.key, set: { routeGroupId } })
    .returning({ id: ticketCategories.id });
  return row!.id;
}

/** Instagram DMs, routing by category. */
async function instagram() {
  const [row] = await db
    .insert(channels)
    .values({ type: 'instagram', name: 'Instagram', config: {}, routingMode: 'category' })
    .returning({ id: channels.id });
  return row!.id;
}

async function status(name: string) {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function ticket(values: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'instagram',
      statusId: await status('Open'),
      requesterContactId: contact!.id,
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

/**
 * A ticket in its routing window, as `startRouting` and `beginRouting` leave
 * one: the window on the ticket, and a `holding` decision row.
 */
async function heldTicket(
  channelId: string,
  fromGroupId: string,
  windowEndsAt: Date,
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const id = await ticket({
    channelId,
    groupId: fromGroupId,
    routingWindowEndsAt: windowEndsAt,
    ...values,
  });
  await db.insert(routingDecisions).values({
    conversationId: id,
    channelId,
    shadow: false,
    stage: 'holding',
    fromGroupId,
    windowEndsAt,
  });
  return id;
}

async function row(id: string) {
  const [found] = await db
    .select({
      groupId: conversations.groupId,
      assignee: conversations.assigneeAgentId,
      decidedAt: conversations.routingDecidedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return found!;
}

const HAND_OVER = ['group_changed', 'unassigned', 'assigned', 'assignment_skipped', 'routed'];

async function eventsOf(id: string, types = HAND_OVER) {
  return db
    .select({
      type: conversationEvents.type,
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, types)))
    .orderBy(asc(conversationEvents.createdAt));
}

/**
 * The hand-over's events in the order the ticket page draws them — by
 * `created_at` — each with whether it sorts strictly after the one before.
 * Asked of Postgres, because the stamps are microseconds apart inside one
 * transaction and a JavaScript `Date` keeps milliseconds, so a tie read back
 * there would hide exactly the misordering this looks for.
 */
async function timelineOf(id: string) {
  return db
    .select({
      type: conversationEvents.type,
      afterPrevious: sql<boolean>`coalesce(${conversationEvents.createdAt} > lag(${conversationEvents.createdAt}) over (order by ${conversationEvents.createdAt}, ${conversationEvents.id}), true)`,
    })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, HAND_OVER)),
    )
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
}

describe('handToRouteGroup', () => {
  it('lands a ticket relabelled after its hold with a member of the new group', async () => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor', { role: 'supervisor' });
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar]);
    const salesCategory = await category('sales', sales);
    const channelId = await instagram();

    // The window ends with nothing filed: routing keeps the ticket where it
    // arrived, and the held assignment gives it to Lina.
    const id = await heldTicket(channelId, care, new Date(Date.now() - MINUTE));
    expect(await settleRouting(id)).toBe('decided');
    expect(await row(id)).toMatchObject({ groupId: care, assignee: lina });

    // After the hold a person's category edit relabels and nothing more.
    expect((await setConversationCategory(id, salesCategory, { agentId: mona })).outcome).toBe(
      'changed',
    );
    expect(await row(id)).toMatchObject({ groupId: care, assignee: lina });
    const before = (await eventsOf(id)).length;

    expect(
      await handToRouteGroup(
        id,
        { agentId: mona },
        { expectedGroupId: sales, expectedAssigneeId: lina },
      ),
    ).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: omar,
      skipped: null,
      waitsIn: null,
    });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: omar });

    // In the order the plan names them, and no second `routed`: routing had
    // already decided.
    expect((await eventsOf(id)).slice(before)).toEqual([
      {
        type: 'group_changed',
        actorAgentId: mona,
        actorLabel: null,
        data: { to: sales, from: care },
      },
      {
        type: 'unassigned',
        actorAgentId: mona,
        actorLabel: null,
        data: { to: null, from: lina },
      },
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'auto_assign',
        data: { to: omar, strategy: 'round_robin' },
      },
    ]);
  });

  it('moves a ticket nobody holds without saying it was unassigned', async () => {
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', []);
    const sales = await group('Inbound Sales Team', [omar]);
    const id = await ticket({ groupId: care, categoryId: await category('sales', sales) });

    expect(await handToRouteGroup(id, { agentId: mona })).toMatchObject({
      ok: true,
      assignedTo: omar,
    });
    expect((await eventsOf(id)).map((event) => event.type)).toEqual(['group_changed', 'assigned']);
  });

  // Still a hand-over: the ticket is in the group's queue, where somebody will
  // look for it, and the answer says nobody was given it.
  it('leaves the ticket in the new group when nobody there can be given it', async () => {
    const lina = await agent('Lina Care');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [], { assignmentStrategy: 'manual' });
    const id = await ticket({
      groupId: care,
      assigneeAgentId: lina,
      categoryId: await category('sales', sales),
    });

    expect(await handToRouteGroup(id, { agentId: mona })).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: null,
      skipped: 'strategy_manual',
      waitsIn: { groupName: 'Inbound Sales Team', movedOn: false },
    });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: null });
    expect((await eventsOf(id)).map((event) => event.type)).toEqual([
      'group_changed',
      'unassigned',
    ]);
  });

  // The rota answers for the group the rules left the ticket in, so the
  // queue it waits in is that group's — and a ticket a rule resolved waits in
  // nobody's. "It waits in the group's queue" said of the route group was
  // false in both.
  describe('says whose queue the ticket waits in only when it waits in one', () => {
    async function onUpdate(name: string, groupId: string, actions: unknown[]) {
      await db.insert(automationRules).values({
        name,
        trigger: 'on_update',
        conditions: { field: 'group.id', op: 'eq', value: groupId },
        actions,
      });
    }

    it('names the group a rule moved it on to, whose rota found nobody', async () => {
      const mona = await agent('Mona Supervisor');
      const care = await group('Customer Care', []);
      const sales = await group('Inbound Sales Team', [await agent('Omar Sales')]);
      const merchants = await group('Merchant Care', [], { assignmentStrategy: 'manual' });
      await onUpdate('Sales goes to Merchant Care', sales, [
        { type: 'assign_group', groupId: merchants },
      ]);
      const id = await ticket({ groupId: care, categoryId: await category('sales', sales) });

      expect(await handToRouteGroup(id, { agentId: mona })).toEqual({
        ok: true,
        groupName: 'Inbound Sales Team',
        assignedTo: null,
        skipped: 'strategy_manual',
        waitsIn: { groupName: 'Merchant Care', movedOn: true },
      });
      expect(await row(id)).toMatchObject({ groupId: merchants, assignee: null });
    });

    it('names none when a rule resolved the ticket', async () => {
      const mona = await agent('Mona Supervisor');
      const care = await group('Customer Care', []);
      const sales = await group('Inbound Sales Team', [await agent('Omar Sales')]);
      await onUpdate('Sales is resolved on sight', sales, [
        { type: 'set_status', category: 'resolved' },
      ]);
      const id = await ticket({ groupId: care, categoryId: await category('sales', sales) });

      expect(await handToRouteGroup(id, { agentId: mona })).toEqual({
        ok: true,
        groupName: 'Inbound Sales Team',
        assignedTo: null,
        skipped: 'not_assignable',
        waitsIn: null,
      });
    });
  });

  // The ticket's row is locked as its own UPDATEs lock it, never `for update`,
  // which waits for — and makes wait — the key-share lock a message takes on
  // its ticket through the foreign key: a customer writing while an agent
  // hands the ticket over would stand behind the whole of it.
  it('lets a customer’s message land on the ticket while the hand-over holds it', async () => {
    const lina = await agent('Lina Care');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [await agent('Omar Sales')]);
    const id = await ticket({
      groupId: care,
      assigneeAgentId: lina,
      categoryId: await category('sales', sales),
    });

    // Every lock the hand-over takes is held, and nothing has committed.
    const held = holdNextTransaction('after');
    const handing = handToRouteGroup(id, { agentId: mona });
    await held.atHold;
    try {
      const landing = db
        .insert(messages)
        .values({ conversationId: id, direction: 'inbound', kind: 'reply', bodyText: 'Any news?' })
        .then(() => 'landed' as const);
      const waited = new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 1_000));
      expect(await Promise.race([landing, waited])).toBe('landed');
    } finally {
      held.release();
    }
    expect(await handing).toMatchObject({ ok: true });
  });

  // The move and the unassignment have committed when the rota runs, so a
  // throw there is not the hand-over failing: it is logged, and the answer
  // says the hand-over is done and that who holds the ticket is not known —
  // thrown on instead, it told the agent the hand-over had failed while the
  // ticket sat in the new group with nobody, and skipped the page's refresh.
  // A trigger refusing the `assigned` line stands in for whatever throws.
  it('answers the hand-over as done when the assignment after it throws', async () => {
    const lina = await agent('Lina Care');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [await agent('Omar Sales')]);
    const id = await ticket({
      groupId: care,
      assigneeAgentId: lina,
      categoryId: await category('sales', sales),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await db.execute(sql`
      create function refuse_assigned() returns trigger language plpgsql
      as $$ begin raise exception 'refused for the test'; end $$`);
    await db.execute(sql`
      create trigger refuse_assigned before insert on conversation_events
      for each row when (new.type = 'assigned') execute function refuse_assigned()`);
    let answer;
    let logged: string[] = [];
    try {
      answer = await handToRouteGroup(id, { agentId: mona });
    } finally {
      await db.execute(sql`drop trigger refuse_assigned on conversation_events`);
      await db.execute(sql`drop function refuse_assigned()`);
      logged = errors.mock.calls.map((call) => String(call[0]));
      errors.mockRestore();
    }

    expect(answer).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: null,
      skipped: null,
      waitsIn: null,
      assignmentFailed: true,
    });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: null });
    expect((await eventsOf(id)).map((event) => event.type)).toEqual([
      'group_changed',
      'unassigned',
    ]);
    expect(logged).toEqual([
      expect.stringContaining(`could not assign ${id} after handing it over`),
    ]);
  });

  // The one ticket the hand-over meets undecided: its window passed and the
  // grace ran out on a settle that never came, so nothing holds it any more.
  // The agent has decided where it goes, and the route ends as theirs.
  it('ends a route whose grace ran out as the agent’s', async () => {
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', []);
    const sales = await group('Inbound Sales Team', [omar]);
    const stuck = new Date(Date.now() - ROUTING_GRACE_MS - 5 * MINUTE);
    const id = await heldTicket(await instagram(), care, stuck, {
      categoryId: await category('sales', sales),
    });

    expect(await handToRouteGroup(id, { agentId: mona })).toMatchObject({
      ok: true,
      assignedTo: omar,
    });
    expect((await row(id)).decidedAt).not.toBeNull();
    const [decision] = await db
      .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    expect(decision).toEqual({ stage: 'decided', outcome: 'manual' });
    expect(await eventsOf(id, ['routed'])).toEqual([
      {
        type: 'routed',
        actorAgentId: mona,
        actorLabel: null,
        data: {
          outcome: 'manual',
          from: care,
          to: sales,
          toName: 'Inbound Sales Team',
          moved: true,
        },
      },
    ]);
    // The route ends after the move that decided it, as the page reads it.
    expect(await timelineOf(id)).toEqual([
      { type: 'group_changed', afterPrevious: true },
      { type: 'routed', afterPrevious: true },
      { type: 'assigned', afterPrevious: true },
    ]);
  });

  // `endHold` writes its `routed` in the transaction of the write that ended
  // the hold, after it. Stamped with the column default — the instant that
  // transaction began — it sorted before the move and the unassignment it
  // came after, and the page told the story backwards: routed to Sales, then
  // moved there, then taken off Lina. Stamped as it is written, it follows
  // them. Here the rota gave the ticket to Lina once the grace ran out, as the
  // sweep would, so the hand-over has somebody to take it off.
  it('records the end of a lapsed route after the move and the unassignment', async () => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar]);
    const stuck = new Date(Date.now() - ROUTING_GRACE_MS - 5 * MINUTE);
    const id = await heldTicket(await instagram(), care, stuck, {
      categoryId: await category('sales', sales),
    });
    expect((await assignConversation(id)).assignedTo).toBe(lina);
    const before = await eventsOf(id);

    expect(await handToRouteGroup(id, { agentId: mona })).toMatchObject({
      ok: true,
      assignedTo: omar,
    });

    expect((await eventsOf(id)).slice(before.length)).toMatchObject([
      { type: 'group_changed', actorAgentId: mona },
      { type: 'unassigned', actorAgentId: mona, data: { from: lina } },
      { type: 'routed', actorAgentId: mona, data: { outcome: 'manual', to: sales } },
      { type: 'assigned', data: { to: omar } },
    ]);
    expect((await timelineOf(id)).slice(before.length)).toEqual([
      { type: 'group_changed', afterPrevious: true },
      { type: 'unassigned', afterPrevious: true },
      { type: 'routed', afterPrevious: true },
      { type: 'assigned', afterPrevious: true },
    ]);
  });

  // A ticket somebody holds is offered the hand-over even while the router is
  // finishing a decision on it — phase one written, its rules still to run —
  // here one the router found `taken`. The move and the unassignment stand
  // and end nothing (`endHold`), and the rest is handed to the router whole
  // (`deferToRouter`): no pass, policy or assignment of the hand-over's own,
  // and an answer naming no holder and no queue. The router's end of the
  // hold, after its pass, assigns it in the group it was handed to. Ending
  // the hold itself, the hand-over assigned before the router's pass, which
  // then ran on a ticket somebody held.
  it('on a decision in flight, moves and unassigns, and leaves the assignment to the router', async () => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor', { role: 'supervisor' });
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar]);
    const salesCategory = await category('sales', sales);
    const id = await heldTicket(await instagram(), care, new Date(Date.now() + 3 * MINUTE), {
      assigneeAgentId: lina,
    });
    expect(
      (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
    ).toBe('changed');

    // The hand-over lands the moment Jev's phase one commits.
    let handed: HandToResult | undefined;
    const transaction = PgDatabase.prototype.transaction;
    vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
      this: PgDatabase<never>,
      run,
      config,
    ) {
      const result: unknown = await transaction.call(this, run, config);
      handed = await handToRouteGroup(
        id,
        { agentId: mona },
        { expectedGroupId: sales, expectedAssigneeId: lina },
      );
      return result as never;
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');
    vi.restoreAllMocks();

    expect(handed).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: null,
      skipped: 'awaiting_route',
      waitsIn: null,
    });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: omar });
    expect((await row(id)).decidedAt).not.toBeNull();
    const [decision] = await db
      .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    expect(decision).toEqual({ stage: 'decided', outcome: 'taken' });
    expect(await eventsOf(id)).toMatchObject([
      { type: 'routed', actorLabel: 'routing', data: { outcome: 'taken', moved: false } },
      { type: 'group_changed', actorAgentId: mona, data: { to: sales, from: care } },
      { type: 'unassigned', actorAgentId: mona, data: { from: lina } },
      { type: 'assigned', data: { to: omar } },
    ]);
  });

  // A rule's pick kept for the hold's end — round robin, asked for while the
  // ticket sat unassigned in Customer Care — speaks about Customer Care. The
  // router found the ticket taken and left it there, so the pick stood; the
  // hand-over then moves it to Sales, which assigns by hand, and the move
  // drops the pick (`endHold`'s `movedGroup`). Kept, the router's end
  // of the hold made it in Sales under the Care rule's name, a rota Sales'
  // admin had turned off.
  it('on a decision in flight, drops a rule’s pick kept for the group it moves the ticket out of', async () => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Supervisor', { role: 'supervisor' });
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar], { assignmentStrategy: 'manual' });
    const salesCategory = await category('sales', sales);
    const id = await heldTicket(await instagram(), care, new Date(Date.now() + 3 * MINUTE));
    expect(
      await assignConversation(id, {
        strategy: 'round_robin',
        actorLabel: 'automation:Care: round robin',
      }),
    ).toMatchObject({ assignedTo: null, reason: 'awaiting_route' });
    await db
      .update(conversations)
      .set({ assigneeAgentId: lina, assignedAt: new Date() })
      .where(eq(conversations.id, id));
    expect(
      (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
    ).toBe('changed');

    const { routed, handed } = await routeWithHandOverBetween({
      afterRouterTransaction: 1,
      route: () => routeNow(id, { label: 'jev:category' }),
      handOver: () =>
        handToRouteGroup(
          id,
          { agentId: mona },
          { expectedGroupId: sales, expectedAssigneeId: lina },
        ),
    });

    expect(routed).toBe('decided');
    expect(handed).toMatchObject({ ok: true, skipped: 'awaiting_route' });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: null });
    expect((await row(id)).decidedAt).not.toBeNull();
    expect((await eventsOf(id, ['assigned'])).map((event) => event.actorLabel)).toEqual([]);
    const [decision] = await db
      .select({
        outcome: routingDecisions.outcome,
        heldStrategy: routingDecisions.heldStrategy,
        heldActorLabel: routingDecisions.heldActorLabel,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    expect(decision).toEqual({ outcome: 'taken', heldStrategy: null, heldActorLabel: null });
  });

  // The hand-over lands once the router's pass has read the ticket — still
  // Lina's, in Customer Care — and before its phase three, and what it does
  // after its write lags the router. Run by the hand-over then, its pass
  // moved the ticket on from Sales after the router's end of the hold had
  // handed it to Omar there, and Omar held a Merchant Care ticket. Handed to
  // the router, the pass runs again on Sales before anybody is assigned.
  it('on a decision in flight, the router’s pass runs on the hand-over before it assigns', async () => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const mona = await agent('Mona Merchant');
    const supervisor = await agent('Mona Supervisor', { role: 'supervisor' });
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar]);
    const merchants = await group('Merchant Care', [mona]);
    const salesCategory = await category('sales', sales);
    await db.insert(automationRules).values({
      name: 'Sales goes to Merchant Care',
      trigger: 'on_update',
      conditions: { field: 'group.id', op: 'eq', value: sales },
      actions: [{ type: 'assign_group', groupId: merchants }],
    });
    const id = await heldTicket(await instagram(), care, new Date(Date.now() + 3 * MINUTE), {
      assigneeAgentId: lina,
    });
    expect(
      (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
    ).toBe('changed');

    // Phase one, then the claim that reads the ticket for the pass.
    const { routed, handed } = await routeWithHandOverBetween({
      afterRouterTransaction: 2,
      route: () => routeNow(id, { label: 'jev:category' }),
      handOver: () =>
        handToRouteGroup(
          id,
          { agentId: supervisor },
          { expectedGroupId: sales, expectedAssigneeId: lina },
        ),
    });

    expect(routed).toBe('decided');
    expect(await row(id)).toMatchObject({ groupId: merchants, assignee: mona });
    expect(handed).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: null,
      skipped: 'awaiting_route',
      waitsIn: null,
    });
    expect(
      (await eventsOf(id, ['group_changed', 'unassigned', 'assigned'])).map((event) => ({
        type: event.type,
        to: event.data.to,
      })),
    ).toEqual([
      { type: 'group_changed', to: sales },
      { type: 'unassigned', to: null },
      { type: 'group_changed', to: merchants },
      { type: 'assigned', to: mona },
    ]);
  });

  describe('refuses, and writes nothing', () => {
    async function desk() {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const mona = await agent('Mona Supervisor');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      return { lina, mona, care, sales, salesCategory: await category('sales', sales) };
    }

    async function expectUntouched(id: string, groupId: string, assignee: string | null) {
      expect(await row(id)).toMatchObject({ groupId, assignee });
      expect(await eventsOf(id)).toEqual([]);
    }

    it('while the ticket is held: a category edit routes it then', async () => {
      const { mona, care, salesCategory } = await desk();
      const id = await heldTicket(await instagram(), care, new Date(Date.now() + 3 * MINUTE), {
        categoryId: salesCategory,
      });

      expect(await handToRouteGroup(id, { agentId: mona })).toEqual({ ok: false, reason: 'held' });
      await expectUntouched(id, care, null);
      expect((await row(id)).decidedAt).toBeNull();
    });

    it('in its category’s group already, or with a category that routes nowhere', async () => {
      const { lina, mona, care, sales, salesCategory } = await desk();
      const there = await ticket({
        groupId: sales,
        categoryId: salesCategory,
        assigneeAgentId: lina,
      });
      expect(await handToRouteGroup(there, { agentId: mona })).toEqual({
        ok: false,
        reason: 'already_there',
      });
      await expectUntouched(there, sales, lina);

      const nowhere = await ticket({
        groupId: care,
        categoryId: await category('courier_jobs', null),
        assigneeAgentId: lina,
      });
      expect(await handToRouteGroup(nowhere, { agentId: mona })).toEqual({
        ok: false,
        reason: 'no_route',
      });
      await expectUntouched(nowhere, care, lina);

      const unfiled = await ticket({ groupId: care, assigneeAgentId: lina });
      expect(await handToRouteGroup(unfiled, { agentId: mona })).toEqual({
        ok: false,
        reason: 'no_route',
      });
    });

    it('once the ticket is no longer open work', async () => {
      const { lina, mona, care, salesCategory } = await desk();
      const resolved = await ticket({
        groupId: care,
        categoryId: salesCategory,
        assigneeAgentId: lina,
        statusId: await status('Resolved'),
      });
      expect(await handToRouteGroup(resolved, { agentId: mona })).toEqual({
        ok: false,
        reason: 'not_open',
      });
      await expectUntouched(resolved, care, lina);

      const spam = await ticket({ groupId: care, categoryId: salesCategory, isSpam: true });
      expect(await handToRouteGroup(spam, { agentId: mona })).toEqual({
        ok: false,
        reason: 'not_open',
      });
    });

    // The page drew one click from the assignee it was drawn with, so a ticket
    // somebody took since — or somebody other than the colleague it named —
    // is refused, not taken off them by a click that asked once.
    it('when somebody other than the assignee the page showed holds it', async () => {
      const { lina, mona, care, sales, salesCategory } = await desk();
      const hana = await agent('Hana Care');
      const id = await ticket({ groupId: care, categoryId: salesCategory, assigneeAgentId: lina });

      for (const shown of [null, hana]) {
        expect(
          await handToRouteGroup(
            id,
            { agentId: mona },
            { expectedGroupId: sales, expectedAssigneeId: shown },
          ),
        ).toEqual({ ok: false, reason: 'reassigned' });
        await expectUntouched(id, care, lina);
      }

      // And one let go of since: the agent confirmed taking it off Lina, and
      // the page drawn again shows them what the ticket is now.
      const freed = await ticket({ groupId: care, categoryId: salesCategory });
      expect(
        await handToRouteGroup(freed, { agentId: mona }, { expectedAssigneeId: lina }),
      ).toEqual({ ok: false, reason: 'reassigned' });
    });

    // The button named the group the category routed to when the page was
    // drawn; the form's id is compared, never followed.
    it('when the category has changed since the page named the group', async () => {
      const { lina, mona, care, salesCategory } = await desk();
      const id = await ticket({ groupId: care, categoryId: salesCategory, assigneeAgentId: lina });

      expect(await handToRouteGroup(id, { agentId: mona }, { expectedGroupId: care })).toEqual({
        ok: false,
        reason: 'changed',
      });
      await expectUntouched(id, care, lina);
    });

    // The owner is outside the rota: a cleared ticket would go straight back
    // to them. A deactivated owner is nobody, and the rota takes it.
    it('on a WhatsApp number whose active owner answers for it', async () => {
      const { lina, mona, care, sales, salesCategory } = await desk();
      const [phone] = await db
        .insert(channels)
        .values({ type: 'whatsapp', name: 'Lina’s phone', ownerAgentId: lina, config: {} })
        .returning({ id: channels.id });
      const owned = {
        channel: 'whatsapp' as const,
        channelId: phone!.id,
        groupId: care,
        categoryId: salesCategory,
        assigneeAgentId: lina,
        accountableAgentId: lina,
      };

      const id = await ticket(owned);
      expect(await handToRouteGroup(id, { agentId: mona })).toEqual({
        ok: false,
        reason: 'owned_number',
      });
      await expectUntouched(id, care, lina);

      await db.update(agents).set({ isActive: false }).where(eq(agents.id, lina));
      const left = await ticket(owned);
      expect(await handToRouteGroup(left, { agentId: mona })).toMatchObject({ ok: true });
      expect((await row(left)).groupId).toBe(sales);
    });

    it('on a coexistence number, answered from the phone', async () => {
      const { lina, mona, care, salesCategory } = await desk();
      const [phone] = await db
        .insert(channels)
        .values({
          type: 'whatsapp',
          name: 'Business app',
          config: {
            phoneNumberId: '1001',
            coexistence: {
              wabaId: '2002',
              displayPhoneNumber: '+20 100 000 0000',
              onboardedAt: new Date().toISOString(),
              syncs: {},
            },
          },
        })
        .returning({ id: channels.id });
      const id = await ticket({
        channel: 'whatsapp',
        channelId: phone!.id,
        groupId: care,
        categoryId: salesCategory,
        assigneeAgentId: lina,
      });

      expect(await handToRouteGroup(id, { agentId: mona })).toEqual({
        ok: false,
        reason: 'coexistence',
      });
      await expectUntouched(id, care, lina);
    });

    it('a ticket that does not exist', async () => {
      const { mona } = await desk();
      expect(
        await handToRouteGroup('5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { agentId: mona }),
      ).toEqual({ ok: false, reason: 'not_found' });
    });
  });
});

/** Who opened a transaction: the router's call, or the hand-over. */
const opener = new AsyncLocalStorage<'router' | 'hand-over'>();

/**
 * Runs `route` with `handOver` landing once the router's
 * `afterRouterTransaction`th transaction has committed, before the router
 * goes on — the hand-over's write commits there — and holds every
 * transaction the hand-over opens after its write until the router has
 * finished: its follow-ups lagging the router, made certain. Transactions are
 * told apart by who opened them.
 */
async function routeWithHandOverBetween({
  afterRouterTransaction,
  route,
  handOver,
}: {
  afterRouterTransaction: number;
  route: () => Promise<RouteResult>;
  handOver: () => Promise<HandToResult>;
}): Promise<{ routed: RouteResult; handed: HandToResult | undefined }> {
  const real = PgDatabase.prototype.transaction;
  let routerOpened = 0;
  let handOverOpened = 0;
  let handing: Promise<HandToResult> | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));

  const spy = vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementation(async function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    const who = opener.getStore();
    if (who === 'hand-over') {
      const nth = ++handOverOpened;
      if (nth > 1) await released;
      const result: unknown = await real.call(this, run, config);
      if (nth === 1) wrote();
      return result as never;
    }
    if (who === 'router') {
      const nth = ++routerOpened;
      const result: unknown = await real.call(this, run, config);
      if (nth === afterRouterTransaction) {
        handing = opener.run('hand-over', handOver);
        await Promise.race([written, handing]);
      }
      return result as never;
    }
    return real.call(this, run, config) as never;
  });

  try {
    const routed = await opener.run('router', route);
    release();
    return { routed, handed: await handing };
  } finally {
    spy.mockRestore();
  }
}
