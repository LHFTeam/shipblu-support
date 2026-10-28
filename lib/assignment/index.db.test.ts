import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  automationRules,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  routingDecisions,
  skills,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { createTicket } from '@/lib/portal/tickets';
import { ROUTING_GRACE_MS } from '@/lib/routing/hold';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { assignConversation, recordLineIn } from './index';

/**
 * The owner's path through `assignConversation`, against Postgres: an
 * unassigned ticket on a WhatsApp number that belongs to somebody goes back to
 * them, past every gate the rota would ask about, and a deactivated owner is
 * nobody. The skill match, reading a category `createTicket` filed in the
 * ticket's insert. And the router's hold, with the re-read under the ticket's
 * lock that keeps a pick from landing on a ticket that moved or was taken.
 */

withCleanDatabase();

/** A Friday: the seeded Cairo week is shut, so a group that keeps hours refuses. */
const FRIDAY = new Date('2026-10-23T10:00:00Z');

async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@shipblu.test`, ...values })
    .returning({ id: agents.id });
  return row!.id;
}

async function group(name: string, values: Partial<typeof groups.$inferInsert> = {}) {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', ...values })
    .returning({ id: groups.id });
  return row!.id;
}

/** The owner's phone. */
async function phone(ownerId: string) {
  const [channel] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name: 'Nayera Mohamed', ownerAgentId: ownerId, config: {} })
    .returning({ id: channels.id });
  return channel!.id;
}

/** An unassigned open ticket on the owner's phone, which they answer for. */
async function ownedTicket(
  ownerId: string,
  values: Partial<typeof conversations.$inferInsert> = {},
  channelId?: string,
) {
  const onPhone = channelId ?? (await phone(ownerId));
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
      channel: 'whatsapp',
      channelId: onPhone,
      statusId: status!.id,
      requesterContactId: contact!.id,
      accountableAgentId: ownerId,
      ...values,
    })
    .returning({ id: conversations.id });
  return { id: row!.id, channelId: onPhone };
}

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      assignee: conversations.assigneeAgentId,
      accountable: conversations.accountableAgentId,
      groupId: conversations.groupId,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function statusId(name: string) {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function eventsOf(id: string, types: string[]) {
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

describe('assignConversation on a ticket whose WhatsApp number has an owner', () => {
  it('hands it to the owner whatever the group, its strategy, its hours or the owner’s presence', async () => {
    // Offline, switched off and allowed no tickets at all: the rota would give
    // her none of these, and she is in none of the groups.
    const nayera = await agent('Nayera Mohamed', {
      presence: 'offline',
      isAcceptingTickets: false,
      acceptingOffReason: 'self',
      acceptingChangedAt: new Date(),
      maxOpenTickets: 0,
    });
    const channelId = await phone(nayera);
    const manual = await group('Merchant Care', { assignmentStrategy: 'manual' });
    const empty = await group('Inbound Sales');
    const shut = await group('Returns', { assignWithinHoursOnly: true });

    for (const groupId of [null, manual, empty, shut]) {
      const ticket = await ownedTicket(nayera, { groupId }, channelId);

      const outcome = await assignConversation(ticket.id, { now: FRIDAY });

      expect(outcome).toEqual({ assignedTo: nayera, reason: null, movedGroup: false });
      expect(await ticketRow(ticket.id)).toMatchObject({ assignee: nayera, groupId });
      expect(await eventsOf(ticket.id, ['assigned', 'assignment_skipped'])).toEqual([
        {
          type: 'assigned',
          actorAgentId: null,
          actorLabel: 'auto_assign',
          data: { to: nayera, reason: 'number_owner', channelId },
        },
      ]);
    }

    // No rota was consulted, so no group's cursor moved.
    const cursors = await db.select({ cursor: groups.lastAssignedAgentId }).from(groups);
    expect(cursors.every((row) => row.cursor === null)).toBe(true);
  });

  // A rule routing an owned ticket is still describing where the work belongs;
  // returning the owner before the move silently dropped that half.
  it('moves the ticket to a group a rule named, then gives it to the owner', async () => {
    const nayera = await agent('Nayera Mohamed');
    const merchantCare = await group('Merchant Care');
    const ticket = await ownedTicket(nayera);

    const outcome = await assignConversation(ticket.id, {
      groupId: merchantCare,
      actorLabel: 'automation:Route merchants',
    });

    expect(outcome).toEqual({ assignedTo: nayera, reason: null, movedGroup: true });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: nayera, groupId: merchantCare });
    expect(await eventsOf(ticket.id, ['group_changed', 'assigned'])).toEqual([
      {
        type: 'group_changed',
        actorAgentId: null,
        actorLabel: 'automation:Route merchants',
        data: { to: merchantCare },
      },
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'automation:Route merchants',
        data: { to: nayera, reason: 'number_owner', channelId: ticket.channelId },
      },
    ]);
  });

  // Ingest stamps the owner into the insert, so this is the shape an `auto_assign`
  // rule actually meets — the unassigned case above is only reached after an
  // Unassign. Before the fix the call returned `already_assigned` first and the
  // owned ticket never reached the rule's group.
  it('moves a ticket its owner already holds to the group a rule named', async () => {
    const nayera = await agent('Nayera Mohamed');
    const merchantCare = await group('Merchant Care');
    const ticket = await ownedTicket(nayera, { assigneeAgentId: nayera, assignedAt: new Date() });

    const outcome = await assignConversation(ticket.id, {
      groupId: merchantCare,
      actorLabel: 'automation:Route merchants',
    });

    expect(outcome).toEqual({ assignedTo: null, reason: 'already_assigned', movedGroup: true });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: nayera, groupId: merchantCare });
    expect(await eventsOf(ticket.id, ['group_changed', 'assigned'])).toEqual([
      {
        type: 'group_changed',
        actorAgentId: null,
        actorLabel: 'automation:Route merchants',
        data: { to: merchantCare },
      },
    ]);
  });

  it('leaves the group of an owned ticket somebody else was given', async () => {
    const nayera = await agent('Nayera Mohamed');
    const bob = await agent('Bob');
    const merchantCare = await group('Merchant Care');
    const ticket = await ownedTicket(nayera, { assigneeAgentId: bob, assignedAt: new Date() });

    const outcome = await assignConversation(ticket.id, { groupId: merchantCare });

    expect(outcome).toEqual({ assignedTo: null, reason: 'already_assigned', movedGroup: false });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: bob, groupId: null });
  });

  it('still gives it to the owner when the group a rule named is gone', async () => {
    const nayera = await agent('Nayera Mohamed');
    const ticket = await ownedTicket(nayera);

    const outcome = await assignConversation(ticket.id, {
      groupId: '00000000-0000-4000-8000-000000000000',
    });

    expect(outcome).toEqual({ assignedTo: nayera, reason: null, movedGroup: false });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: nayera, groupId: null });
    expect(await eventsOf(ticket.id, ['group_changed'])).toEqual([]);
  });

  it('leaves a ticket somebody already holds', async () => {
    const nayera = await agent('Nayera Mohamed');
    const bob = await agent('Bob Supervisor');
    const ticket = await ownedTicket(nayera, { assigneeAgentId: bob });

    expect(await assignConversation(ticket.id)).toEqual({
      assignedTo: null,
      reason: 'already_assigned',
      movedGroup: false,
    });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: bob, accountable: nayera });
  });

  // A deactivated owner is nobody: the ticket takes the rota like any other,
  // and stays accountable to the owner until an admin hands the number over.
  it('routes through the group as usual when the owner is deactivated', async () => {
    const nayera = await agent('Nayera Mohamed', { isActive: false });
    const omar = await agent('Omar Agent', { presence: 'online', lastSeenAt: new Date() });
    const support = await group('Merchant Care', { assignWithinHoursOnly: false });
    await db.insert(groupMembers).values({ groupId: support, agentId: omar });
    const ticket = await ownedTicket(nayera, { groupId: support });

    const outcome = await assignConversation(ticket.id);

    expect(outcome).toEqual({ assignedTo: omar, reason: null, movedGroup: false });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: omar, accountable: nayera });
    expect((await eventsOf(ticket.id, ['assigned']))[0]!.data).toEqual({
      to: omar,
      strategy: 'round_robin',
    });
  });

  // The rota's own path, which no owner takes: the move is made once, before
  // the branches, and reported, so a rule routing an unowned ticket owes the
  // SLA its re-time and its second look (`lib/automations`, `Pass.groupMoved`).
  it('moves a ticket the rota picks for into the group a rule named, and says so', async () => {
    const nayera = await agent('Nayera Mohamed', { isActive: false });
    const omar = await agent('Omar Agent', { presence: 'online', lastSeenAt: new Date() });
    const support = await group('Merchant Care', { assignWithinHoursOnly: false });
    await db.insert(groupMembers).values({ groupId: support, agentId: omar });
    const ticket = await ownedTicket(nayera);

    const outcome = await assignConversation(ticket.id, {
      groupId: support,
      actorLabel: 'automation:Route merchants',
    });

    expect(outcome).toEqual({ assignedTo: omar, reason: null, movedGroup: true });
    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: omar, groupId: support });
    expect((await eventsOf(ticket.id, ['group_changed'])).map((event) => event.data)).toEqual([
      { to: support },
    ]);
  });

  // "Unassign" in the console writes the ticket and then runs the same
  // lifecycle step as every other edit; on an owned ticket that is the owner
  // getting it back in the same request, not on the next sweep.
  it('hands an unassigned ticket straight back to its owner after a console edit', async () => {
    const nayera = await agent('Nayera Mohamed');
    const bob = await agent('Bob Supervisor');
    const ticket = await ownedTicket(nayera, { assigneeAgentId: bob });

    await db
      .update(conversations)
      .set({ assigneeAgentId: null, assignedAt: null })
      .where(eq(conversations.id, ticket.id));
    await afterTicketUpdate(ticket.id);

    expect(await ticketRow(ticket.id)).toMatchObject({ assignee: nayera, accountable: nayera });
  });

  // The owner's path takes the same locked re-read the rota's does. Guarded
  // only on the assignee, its UPDATE handed a ticket resolved, deleted or
  // marked spam between the snapshot and the write straight to the owner, with
  // an `assigned` line after the resolve.
  it.each([
    ['resolved', async () => ({ statusId: await statusId('Resolved') })],
    ['deleted', async () => ({ deletedAt: new Date() })],
    ['marked spam', async () => ({ isSpam: true })],
  ] as const)(
    'does not hand it back once it is %s between the read and the write',
    async (_, change) => {
      const nayera = await agent('Nayera Mohamed');
      const ticket = await ownedTicket(nayera);

      const hold = holdNextTransaction('before');
      const assigning = assignConversation(ticket.id);
      await hold.atHold;
      await db
        .update(conversations)
        .set(await change())
        .where(eq(conversations.id, ticket.id));
      hold.release();

      expect(await assigning).toMatchObject({ assignedTo: null, reason: 'not_assignable' });
      expect((await ticketRow(ticket.id)).assignee).toBeNull();
      expect(await eventsOf(ticket.id, ['assigned'])).toEqual([]);
    },
  );
});

// `createTicket`'s own `afterInboundMessage` assigns the ticket before it
// returns, and the skill match reads `category.id` off the row then
// (`conversationFacts`). So a category is in time for it only in the insert:
// written after `createTicket` returned, it would miss the match, and nothing
// after it re-assigns the way a re-selection re-chooses a policy.
describe('a skill keyed on the category a ticket is created with', () => {
  // The ring is ordered by id, so Amr sorts first and the rota alone picks him.
  const AMR = '00000000-0000-4000-8000-000000000001';
  const SALMA = '00000000-0000-4000-8000-000000000002';

  /** A skill-matching sales desk: Salma holds the skill Sales tickets need, Amr does not. */
  async function salesDesk(salmaValues: Partial<typeof agents.$inferInsert> = {}) {
    const [sales] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'sales'));
    const [skill] = await db
      .insert(skills)
      .values({ name: 'Sales', conditions: { field: 'category.id', op: 'eq', value: sales!.id } })
      .returning({ id: skills.id });
    const here = { presence: 'online' as const, lastSeenAt: new Date() };
    const amr = await agent('Amr Agent', { id: AMR, ...here });
    const salma = await agent('Salma Sales', { id: SALMA, ...here, ...salmaValues });
    await db.insert(agentSkills).values({ agentId: salma, skillId: skill!.id });
    const desk = await group('Inbound Sales', { matchSkills: true, assignWithinHoursOnly: false });
    await db.insert(groupMembers).values([
      { groupId: desk, agentId: amr },
      { groupId: desk, agentId: salma },
    ]);
    return { salesId: sales!.id, skillId: skill!.id, amr, salma, desk };
  }

  /** A ticket a form opens on the desk, with the form's default category when given one. */
  async function opened(groupId: string, categoryId?: string) {
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const { conversationId } = await createTicket(contact!.id, {
      subject: 'Rates',
      body: 'How much to ship 200 parcels a month?',
      groupId,
      ...(categoryId ? { category: { id: categoryId, chosenBy: { label: 'form:sales' } } } : {}),
    });
    return conversationId;
  }

  it('offers a ticket created with the category only to the skill’s holders', async () => {
    const { salesId, skillId, amr, salma, desk } = await salesDesk();

    const filed = await opened(desk, salesId);
    expect(await ticketRow(filed)).toMatchObject({ assignee: salma });
    expect((await eventsOf(filed, ['assigned']))[0]!.data).toEqual({
      to: salma,
      strategy: 'round_robin',
      skills: [skillId],
    });

    // Without the category it asks for no skill, and the rota moves on past
    // Salma to Amr, who could not have had the first.
    const unfiled = await opened(desk);
    expect(await ticketRow(unfiled)).toMatchObject({ assignee: amr });
    expect((await eventsOf(unfiled, ['assigned']))[0]!.data).toEqual({
      to: amr,
      strategy: 'round_robin',
    });
  });

  it('keeps a ticket created with the category waiting while no holder is here', async () => {
    const { salesId, amr, desk } = await salesDesk({ presence: 'offline' });

    const filed = await opened(desk, salesId);
    expect(await ticketRow(filed)).toMatchObject({ assignee: null });
    expect(await eventsOf(filed, ['assigned', 'assignment_skipped'])).toEqual([
      {
        type: 'assignment_skipped',
        actorAgentId: null,
        actorLabel: 'auto_assign',
        data: { reason: 'no_skill_match' },
      },
    ]);

    expect(await ticketRow(await opened(desk))).toMatchObject({ assignee: amr });
  });
});

/**
 * The router's hold (`plans/ticket-category-routing.md`, decision 5): while a
 * ticket's group is not settled nothing assigns it, and nothing says so on the
 * timeline — a timeline entry per skip once produced 1,432 rows for 137
 * tickets. Each test passes `now`, and its agents were last seen then.
 */
describe('assignConversation on a ticket held for the router', () => {
  const MINUTE = 60_000;
  const at = (now: Date, minutes: number) => new Date(now.getTime() + minutes * MINUTE);

  /** A team that takes tickets at `now`: round robin, any hour, one member online. */
  async function desk(name: string, member: string, now: Date) {
    const groupId = await group(name, { assignWithinHoursOnly: false });
    const agentId = await agent(member, { presence: 'online', lastSeenAt: now });
    await db.insert(groupMembers).values({ groupId, agentId });
    return { groupId, agentId };
  }

  /**
   * An unassigned email ticket in `groupId`, its window closing at
   * `windowEndsAt` (none when null), with the routing row the ingest path
   * writes beside it — `holding`, as `beginRouting` leaves it.
   */
  async function ticketIn(
    groupId: string,
    windowEndsAt: Date | null,
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
        groupId,
        statusId: status!.id,
        requesterContactId: contact!.id,
        routingWindowEndsAt: windowEndsAt,
        ...values,
      })
      .returning({ id: conversations.id });
    if (windowEndsAt) {
      await db.insert(routingDecisions).values({
        conversationId: row!.id,
        shadow: false,
        stage: 'holding',
        fromGroupId: groupId,
        windowEndsAt,
      });
    }
    return row!.id;
  }

  async function held(id: string) {
    const [row] = await db
      .select({
        assignee: conversations.assigneeAgentId,
        groupId: conversations.groupId,
        decidedAt: conversations.routingDecidedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!;
  }

  async function routingOf(id: string) {
    const [row] = await db
      .select({
        stage: routingDecisions.stage,
        outcome: routingDecisions.outcome,
        toGroupId: routingDecisions.toGroupId,
        decidedByLabel: routingDecisions.decidedByLabel,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, id));
    return row!;
  }

  async function cursorOf(groupId: string) {
    const [row] = await db
      .select({ cursor: groups.lastAssignedAgentId })
      .from(groups)
      .where(eq(groups.id, groupId));
    return row!.cursor;
  }

  const ASSIGNMENT_EVENTS = ['assigned', 'unassigned', 'assignment_skipped'];

  it('answers awaiting_route while the window runs, and writes nothing at all', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const id = await ticketIn(care.groupId, at(now, 5));

    expect(await assignConversation(id, { now, actorLabel: 'assign_sweep' })).toEqual({
      assignedTo: null,
      reason: 'awaiting_route',
      movedGroup: false,
    });
    expect(await held(id)).toEqual({ assignee: null, groupId: care.groupId, decidedAt: null });
    // Not on the timeline: the badge says "Routing…", and the sweep asks
    // every five minutes.
    expect(await eventsOf(id, ASSIGNMENT_EVENTS)).toEqual([]);
    expect(await cursorOf(care.groupId)).toBeNull();
    expect(await routingOf(id)).toMatchObject({ stage: 'holding', outcome: null });
  });

  // An `auto_assign` rule's strategy, met by the hold before it is read: kept
  // on the routing row for whatever ends the hold (`afterHoldEnded`). The
  // sweep and the creation pass name none, and leave it where it is.
  it('keeps a strategy it was asked for, which a caller naming none leaves alone', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const id = await ticketIn(care.groupId, at(now, 5));
    const kept = async () => {
      const [row] = await db
        .select({
          strategy: routingDecisions.heldStrategy,
          label: routingDecisions.heldActorLabel,
        })
        .from(routingDecisions)
        .where(eq(routingDecisions.conversationId, id));
      return row;
    };

    expect(
      await assignConversation(id, {
        now,
        strategy: 'load_balanced',
        actorLabel: 'automation:Balance care',
      }),
    ).toMatchObject({ reason: 'awaiting_route' });
    expect(await kept()).toEqual({ strategy: 'load_balanced', label: 'automation:Balance care' });

    expect((await assignConversation(id, { now, actorLabel: 'assign_sweep' })).reason).toBe(
      'awaiting_route',
    );
    expect(await kept()).toEqual({ strategy: 'load_balanced', label: 'automation:Balance care' });
    expect(await eventsOf(id, ASSIGNMENT_EVENTS)).toEqual([]);
  });

  // The grace is a valve for a settle that never came, and it is exclusive:
  // the instant it runs out the hold is over, a millisecond before it is not.
  it('holds through the grace and assigns the instant it runs out', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const within = await ticketIn(care.groupId, new Date(now.getTime() - ROUTING_GRACE_MS + 1));
    const over = await ticketIn(care.groupId, new Date(now.getTime() - ROUTING_GRACE_MS));

    expect((await assignConversation(within, { now })).reason).toBe('awaiting_route');
    expect(await assignConversation(over, { now })).toEqual({
      assignedTo: care.agentId,
      reason: null,
      movedGroup: false,
    });
    expect(await held(over)).toMatchObject({ assignee: care.agentId });
    // Nothing decided the late one: the settle, when it comes, finds it taken.
    expect(await routingOf(over)).toMatchObject({ stage: 'holding', outcome: null });
  });

  it('assigns a ticket whose hold was decided, with its window still running', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const id = await ticketIn(care.groupId, at(now, 5), { routingDecidedAt: now });

    expect(await assignConversation(id, { now })).toEqual({
      assignedTo: care.agentId,
      reason: null,
      movedGroup: false,
    });
  });

  // The re-read under the ticket's lock. The group's lock alone does not stop
  // a move out of the group — a move takes the foreign key's lock on the group
  // it goes to — so before it, a ticket the router or a person moved between
  // the read and the write was handed to an agent of the team it had left.
  it('gives up when the ticket left the group between the read and the lock', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const merchants = await desk('Merchant Care', 'Mona Merchant', now);
    const id = await ticketIn(care.groupId, null);

    const hold = holdNextTransaction('before');
    const assigning = assignConversation(id, { now, actorLabel: 'assign_sweep' });
    await hold.atHold;
    await db
      .update(conversations)
      .set({ groupId: merchants.groupId })
      .where(eq(conversations.id, id));
    hold.release();

    expect(await assigning).toEqual({ assignedTo: null, reason: 'moved', movedGroup: false });
    expect(await held(id)).toMatchObject({ assignee: null, groupId: merchants.groupId });
    // Whoever moved it assigns it; this writes nothing, and records nothing.
    expect(await eventsOf(id, ASSIGNMENT_EVENTS)).toEqual([]);
    expect(await cursorOf(care.groupId)).toBeNull();
  });

  it('gives up when somebody picked the ticket up between the read and the lock', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const bob = await agent('Bob Supervisor');
    const id = await ticketIn(care.groupId, null);

    const hold = holdNextTransaction('before');
    const assigning = assignConversation(id, { now });
    await hold.atHold;
    await db
      .update(conversations)
      .set({ assigneeAgentId: bob, assignedAt: now })
      .where(eq(conversations.id, id));
    hold.release();

    expect(await assigning).toEqual({
      assignedTo: null,
      reason: 'already_assigned',
      movedGroup: false,
    });
    expect(await held(id)).toMatchObject({ assignee: bob });
    expect(await eventsOf(id, ['assigned'])).toEqual([]);
    expect(await cursorOf(care.groupId)).toBeNull();
  });

  // The re-read under the lock asks whether the ticket is still work too: an
  // agent resolving it, a merge, a delete or a spam mark landing while the
  // pick waited left the ticket handed to somebody — the cursor moved past
  // them, and an `assigned` line after the resolve — for work nobody may do.
  // The status read beside the lock as a subquery, never a join, which would
  // have answered no row at all for the resolved one.
  const resolvedStatus = async () => {
    const [row] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    return row!.id;
  };
  it.each([
    ['resolved', async () => ({ statusId: await resolvedStatus() })],
    ['merged', async (groupId: string) => ({ mergedIntoId: await ticketIn(groupId, null) })],
    ['deleted', async () => ({ deletedAt: new Date() })],
    ['marked spam', async () => ({ isSpam: true })],
  ] as const)(
    'gives up when the ticket was %s between the read and the lock',
    async (_, change) => {
      const now = new Date();
      const care = await desk('Customer Care', 'Omar Care', now);
      const id = await ticketIn(care.groupId, null);

      const hold = holdNextTransaction('before');
      const assigning = assignConversation(id, { now });
      await hold.atHold;
      await db
        .update(conversations)
        .set(await change(care.groupId))
        .where(eq(conversations.id, id));
      hold.release();

      expect(await assigning).toEqual({
        assignedTo: null,
        reason: 'not_assignable',
        movedGroup: false,
      });
      expect(await held(id)).toMatchObject({ assignee: null });
      expect(await eventsOf(id, ASSIGNMENT_EVENTS)).toEqual([]);
      expect(await cursorOf(care.groupId)).toBeNull();
    },
  );

  // The latent bug the lock fixed beside it: the guarded write's result was
  // never read, so a write that matched nothing still advanced the cursor and
  // recorded `assigned` to somebody who never got the ticket. A trigger that
  // swallows the write stands in for whatever makes it match nothing.
  it('advances no cursor and records no assignment when the write matches nothing', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const id = await ticketIn(care.groupId, null);

    await db.execute(sql`
      create function swallow_assignment() returns trigger language plpgsql
      as $$ begin return null; end $$`);
    await db.execute(sql`
      create trigger swallow_assignment before update on conversations
      for each row when (old.assignee_agent_id is null and new.assignee_agent_id is not null)
      execute function swallow_assignment()`);
    let outcome;
    try {
      outcome = await assignConversation(id, { now });
    } finally {
      await db.execute(sql`drop trigger swallow_assignment on conversations`);
      await db.execute(sql`drop function swallow_assignment()`);
    }

    expect(outcome).toEqual({ assignedTo: null, reason: 'already_assigned', movedGroup: false });
    expect(await held(id)).toMatchObject({ assignee: null });
    expect(await eventsOf(id, ['assigned'])).toEqual([]);
    expect(await cursorOf(care.groupId)).toBeNull();
  });

  // A rule's `auto_assign` naming another team has decided where the ticket
  // goes: the hold ends with the move, and the pick in that team goes ahead.
  it('ends the hold with a grouped auto_assign’s move to another group, and picks there', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const merchants = await desk('Merchant Care', 'Mona Merchant', now);
    const id = await ticketIn(care.groupId, at(now, 5));
    const routed: { moved: boolean; endedHold?: boolean } = { moved: false };

    const outcome = await assignConversation(id, {
      groupId: merchants.groupId,
      actorLabel: 'automation:Route merchants',
      endsHoldAs: 'rule',
      routed,
      now,
    });

    expect(outcome).toEqual({ assignedTo: merchants.agentId, reason: null, movedGroup: true });
    expect(routed).toEqual({ moved: true, endedHold: true });
    expect(await held(id)).toEqual({
      assignee: merchants.agentId,
      groupId: merchants.groupId,
      decidedAt: expect.any(Date),
    });
    expect(await routingOf(id)).toEqual({
      stage: 'decided',
      outcome: 'rule',
      toGroupId: merchants.groupId,
      decidedByLabel: 'automation:Route merchants',
    });
    expect(await eventsOf(id, ['routed'])).toEqual([
      {
        type: 'routed',
        actorAgentId: null,
        actorLabel: 'automation:Route merchants',
        data: {
          outcome: 'rule',
          from: care.groupId,
          to: merchants.groupId,
          toName: 'Merchant Care',
          moved: true,
        },
      },
    ]);
    expect((await eventsOf(id, ['assigned'])).map((event) => event.data)).toEqual([
      { to: merchants.agentId, strategy: 'round_robin' },
    ]);
    expect(await cursorOf(care.groupId)).toBeNull();
  });

  // In the move's own transaction: stamped apart from it, a crash between the
  // two left the ticket in the rule's group still held, for the router to move
  // away from the rule — or ended the hold in the group it was about to leave.
  it('moves nothing when the hold cannot end with the move', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const merchants = await desk('Merchant Care', 'Mona Merchant', now);
    const id = await ticketIn(care.groupId, at(now, 5));

    await db.execute(sql`
      create function refuse_routing_write() returns trigger language plpgsql
      as $$ begin raise exception 'refused for the test'; end $$`);
    await db.execute(sql`
      create trigger refuse_routing_write before update on routing_decisions
      for each row execute function refuse_routing_write()`);
    try {
      await expect(
        assignConversation(id, {
          groupId: merchants.groupId,
          actorLabel: 'automation:Route merchants',
          endsHoldAs: 'rule',
          now,
        }),
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`drop trigger refuse_routing_write on routing_decisions`);
      await db.execute(sql`drop function refuse_routing_write()`);
    }

    expect(await held(id)).toEqual({ assignee: null, groupId: care.groupId, decidedAt: null });
    expect(await routingOf(id)).toMatchObject({ stage: 'holding', outcome: null });
    expect(await eventsOf(id, ['group_changed', 'routed', 'assigned'])).toEqual([]);
  });

  // A rule naming the team the ticket is already in matches on every pass,
  // and has decided nothing; nor has one naming no team at all, which means
  // "assign within the current group". Both are held like any assignment.
  it('keeps the hold for an auto_assign naming the group the ticket is in, or none', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const id = await ticketIn(care.groupId, at(now, 5));
    const routed: { moved: boolean; endedHold?: boolean } = { moved: false };

    for (const groupId of [care.groupId, undefined]) {
      expect(
        await assignConversation(id, {
          groupId,
          actorLabel: 'automation:Route care',
          endsHoldAs: 'rule',
          routed,
          now,
        }),
      ).toEqual({ assignedTo: null, reason: 'awaiting_route', movedGroup: false });
    }

    expect(routed).toEqual({ moved: false });
    expect(await held(id)).toEqual({ assignee: null, groupId: care.groupId, decidedAt: null });
    expect(await routingOf(id)).toMatchObject({ stage: 'holding', outcome: null });
    expect(await eventsOf(id, ['group_changed', 'routed', ...ASSIGNMENT_EVENTS])).toEqual([]);
  });

  // The same two, through the engine that asks them: a pass whose rule ended
  // the hold owes what the hold kept back, once the pass is over.
  it('routes a held ticket by an on_update rule’s auto_assign, and only one naming another group', async () => {
    const now = new Date();
    const care = await desk('Customer Care', 'Omar Care', now);
    const merchants = await desk('Merchant Care', 'Mona Merchant', now);
    const id = await ticketIn(care.groupId, at(now, 30));
    await db.insert(automationRules).values({
      name: 'Keep it in care',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'auto_assign', groupId: care.groupId, strategy: 'group_default' }],
    });

    await runAutomations('on_update', id);

    expect(await held(id)).toEqual({ assignee: null, groupId: care.groupId, decidedAt: null });
    expect(await routingOf(id)).toMatchObject({ stage: 'holding', outcome: null });

    await db.insert(automationRules).values({
      name: 'Route merchants',
      trigger: 'on_update',
      position: 1,
      conditions: {},
      actions: [{ type: 'auto_assign', groupId: merchants.groupId, strategy: 'group_default' }],
    });

    await runAutomations('on_update', id);

    expect(await held(id)).toMatchObject({
      assignee: merchants.agentId,
      groupId: merchants.groupId,
      decidedAt: expect.any(Date),
    });
    expect(await routingOf(id)).toEqual({
      stage: 'decided',
      outcome: 'rule',
      toGroupId: merchants.groupId,
      decidedByLabel: 'automation:Route merchants',
    });
    expect(await eventsOf(id, ['assigned'])).toEqual([
      {
        type: 'assigned',
        actorAgentId: null,
        actorLabel: 'automation:Route merchants',
        data: { to: merchants.agentId, strategy: 'round_robin' },
      },
    ]);
  });
});

/**
 * The line a write records inside its own transaction, in a savepoint: a
 * refusal Postgres returned is answered and the write stands; anything else —
 * the admission gate giving a statement up as lost, a cancel — is thrown on,
 * so the transaction rolls back rather than queue the rest behind a statement
 * that may yet commit.
 */
describe('recordLineIn', () => {
  async function ticketOnPhone() {
    const nayera = await agent('Nayera Mohamed');
    return (await ownedTicket(nayera, { subject: 'Before' })).id;
  }

  async function subjectOf(id: string) {
    const [row] = await db
      .select({ subject: conversations.subject })
      .from(conversations)
      .where(eq(conversations.id, id));
    return row!.subject;
  }

  it('answers a refusal Postgres returned, and the write it records still commits', async () => {
    const id = await ticketOnPhone();
    await db.execute(sql`
      create function refuse_line() returns trigger language plpgsql
      as $$ begin raise exception 'refused for the test'; end $$`);
    await db.execute(sql`
      create trigger refuse_line before insert on conversation_events
      for each row when (new.type = 'group_changed') execute function refuse_line()`);
    try {
      const refused = await db.transaction(async (tx) => {
        await tx.update(conversations).set({ subject: 'After' }).where(eq(conversations.id, id));
        return recordLineIn(tx, { conversationId: id, type: 'group_changed', data: {} });
      });
      expect(refused).toBeInstanceOf(Error);
    } finally {
      await db.execute(sql`drop trigger refuse_line on conversation_events`);
      await db.execute(sql`drop function refuse_line()`);
    }
    expect(await subjectOf(id)).toBe('After');
  });

  it('throws anything else on, and the whole transaction rolls back', async () => {
    const id = await ticketOnPhone();
    const lost = new Error('treated as lost');
    const insert = vi.spyOn(PgDatabase.prototype, 'insert').mockImplementationOnce(() => {
      throw lost;
    });
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.update(conversations).set({ subject: 'After' }).where(eq(conversations.id, id));
          await recordLineIn(tx, { conversationId: id, type: 'group_changed', data: {} });
        }),
      ).rejects.toBe(lost);
    } finally {
      insert.mockRestore();
    }
    expect(await subjectOf(id)).toBe('Before');
  });
});
