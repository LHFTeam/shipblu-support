import { and, asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  skills,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { createTicket } from '@/lib/portal/tickets';
import { withCleanDatabase } from '@/lib/testing/db';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { assignConversation } from './index';

/**
 * The owner's path through `assignConversation`, against Postgres: an
 * unassigned ticket on a WhatsApp number that belongs to somebody goes back to
 * them, past every gate the rota would ask about, and a deactivated owner is
 * nobody. And the skill match, reading a category `createTicket` filed in the
 * ticket's insert.
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
