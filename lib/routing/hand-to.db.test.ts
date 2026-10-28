import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  routingDecisions,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { setConversationCategory } from '@/lib/categories/write';
import { withCleanDatabase } from '@/lib/testing/db';
import { settleRouting } from './apply';
import { handToRouteGroup } from './hand-to';
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

    expect(await handToRouteGroup(id, { agentId: mona }, { expectedGroupId: sales })).toEqual({
      ok: true,
      groupName: 'Inbound Sales Team',
      assignedTo: omar,
      skipped: null,
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
    });
    expect(await row(id)).toMatchObject({ groupId: sales, assignee: null });
    expect((await eventsOf(id)).map((event) => event.type)).toEqual([
      'group_changed',
      'unassigned',
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
