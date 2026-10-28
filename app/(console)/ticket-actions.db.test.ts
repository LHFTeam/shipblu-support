import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  autoResponses,
  automationRules,
  businessHours,
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
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { beginRouting } from '@/lib/routing/begin';
import { startRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The console's ticket edits against Postgres, where the order of what follows
 * a write decides who ends up holding the ticket and what the customer is told
 * (`plans/ticket-category-routing.md`, decision 5).
 *
 * One rule runs through all of it: the `on_update` rules see a console edit
 * before anybody is handed the ticket, and before a hold the edit ended pays
 * its out-of-hours reply. A rule that moves the ticket on from where the agent
 * left it is describing where the work belongs; assigning first leaves a
 * member of the group the ticket is leaving holding it, because `assign_group`
 * never touches an assignee, and a reply sent first is told the hours of a
 * group the ticket is no longer in.
 *
 * Every group assigns at any hour, so who is picked never depends on the
 * clock; the calendars that decide the out-of-hours reply are open round the
 * clock or never, so whether it goes does not either. Every best-effort step
 * logs instead of throwing, so a test fails on any error logged.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));

vi.mock('@/lib/auth/guard', () => ({
  requireAgent: async () => ({
    id: signedIn.id,
    name: 'Mona Supervisor',
    email: 'mona@shipblu.test',
    role: 'admin',
    permissions: {},
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// An admin sees every ticket, so no edit here should send the response to the
// inbox; one that did fails the test with Next's own shape for it.
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));

const { updateTicket } = await import('./ticket-actions');

withCleanDatabase();

let errors: MockInstance;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  signedIn.id = await agent('Mona Supervisor', { role: 'admin', presence: 'offline' });
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

let people = 0;

async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
  people += 1;
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `agent${people}@shipblu.test`,
      presence: 'online',
      lastSeenAt: new Date(),
      ...values,
    })
    .returning({ id: agents.id });
  return row!.id;
}

/** A group that assigns round robin at any hour, with these members. */
async function group(name: string, members: string[]) {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
    .returning({ id: groups.id });
  if (members.length) {
    await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  }
  return row!.id;
}

/** Every day the same: open round the clock, or never. */
const week = (day: { start: string; end: string }[]) => ({
  sun: day,
  mon: day,
  tue: day,
  wed: day,
  thu: day,
  fri: day,
  sat: day,
});
const OPEN = week([{ start: '00:00', end: '24:00' }]);
const SHUT = week([]);

/** A calendar of the group's own, which the held reply then reads. */
async function keeps(groupId: string, name: string, schedule: ReturnType<typeof week>) {
  const [hours] = await db
    .insert(businessHours)
    .values({ name, schedule })
    .returning({ id: businessHours.id });
  await db.update(groups).set({ businessHoursId: hours!.id }).where(eq(groups.id, groupId));
  forgetHoursCatalog();
}

/** The seeded default calendar, shut for good: every group without its own is closed now. */
async function closedEverywhere() {
  await db.update(businessHours).set({ schedule: SHUT }).where(eq(businessHours.isDefault, true));
  forgetHoursCatalog();
}

/** The out-of-hours acknowledgement, on every channel and group. */
async function outOfHoursReply() {
  await db
    .insert(autoResponses)
    .values({ bodyEn: 'Thanks — we are closed, and will reply when we open.' });
}

async function onUpdate(name: string, conditions: unknown, actions: unknown[]) {
  await db.insert(automationRules).values({ name, trigger: 'on_update', conditions, actions });
}

const inGroup = (groupId: string) => ({ field: 'group.id', op: 'eq', value: groupId });

/** A seeded category, pointed at `routeGroupId`. */
async function routeTo(key: string, routeGroupId: string) {
  const [row] = await db
    .update(ticketCategories)
    .set({ routeGroupId })
    .where(eq(ticketCategories.key, key))
    .returning({ id: ticketCategories.id });
  return row!.id;
}

/** The classifier's switch, which routing starts only under (`routingStartFor`). */
async function classifierApplies() {
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, 'apply', 0.6, 5)
    on conflict (id) do update set mode = excluded.mode`);
  forgetCategoryAiSettings();
}

async function mailbox(defaultGroupId: string, routingMode: 'category' | 'category_shadow') {
  const [row] = await db
    .insert(channels)
    .values({ type: 'email', name: 'Support mail', config: {}, defaultGroupId, routingMode })
    .returning({ id: channels.id });
  return row!.id;
}

/**
 * An email ticket in `groupId`, with the customer's opening message — the one
 * a held reply answers.
 */
async function ticket(groupId: string, values: Partial<typeof conversations.$inferInsert> = {}) {
  people += 1;
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: `amira${people}@customer.example` })
    .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const opened = new Date();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      groupId,
      statusId: open!.id,
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      lastMessageAt: opened,
      lastCustomerMessageAt: opened,
      ...values,
    })
    .returning({ id: conversations.id });
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: row!.id,
      direction: 'inbound',
      kind: 'reply',
      bodyText: 'Hello, my parcel has not arrived.',
      createdAt: opened,
    })
    .returning({ id: messages.id });
  return { id: row!.id, messageId: message!.id, opened };
}

/**
 * A ticket on `channelId`'s mail, started as the insert starts one and begun
 * as the creation pass begins it: `holding`, with no category. Live, the
 * window is on the ticket and nothing assigns it; in shadow nothing is held.
 */
async function heldTicket(channelId: string, groupId: string, { shadow = false } = {}) {
  const t = await ticket(groupId, { channelId });
  await db.transaction((tx) =>
    startRouting(
      tx,
      { start: shadow ? 'shadow' : 'live', channelId, windowMinutes: 5 },
      { conversationId: t.id, messageId: t.messageId, groupId },
      t.opened,
    ),
  );
  expect(await beginRouting(t.id)).toBe('continue');
  return t.id;
}

function edit(conversationId: string, field: string, value: string) {
  const data = new FormData();
  data.set('conversationId', conversationId);
  data.set('field', field);
  data.set('value', value);
  return updateTicket({ error: null }, data);
}

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      groupId: conversations.groupId,
      assigneeAgentId: conversations.assigneeAgentId,
      routingDecidedAt: conversations.routingDecidedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function decisionOf(id: string) {
  const [row] = await db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, id));
  return row!;
}

async function eventsOf(id: string, type: string) {
  return db
    .select({
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)));
}

/** The out-of-hours acknowledgements sent on the ticket. */
async function acknowledgements(id: string) {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, id),
        eq(messages.direction, 'outbound'),
        sql`${messages.meta}->>'autoResponse' is not null`,
      ),
    );
}

// --- Tests ------------------------------------------------------------------

describe('updateTicket: a group move', () => {
  // The bug this pins: the group case assigned in the group the person chose,
  // and only then ran the rules, whose `assign_group` moved the ticket on and
  // left the first group's agent holding it.
  it('runs the rules before assigning, so the ticket lands with a member of the group they left it in', async () => {
    const lina = await agent('Lina Care');
    const karim = await agent('Karim Courier');
    const omar = await agent('Omar Merchant');
    const care = await group('Customer Care', [lina]);
    const couriers = await group('Courier Jobs', [karim]);
    const merchants = await group('Merchant Care', [omar]);
    await onUpdate('Courier jobs go to Merchant Care', inGroup(couriers), [
      { type: 'assign_group', groupId: merchants },
    ]);
    const { id } = await ticket(care);

    expect(await edit(id, 'group', couriers)).toMatchObject({ error: null });

    expect(await ticketRow(id)).toMatchObject({ groupId: merchants, assigneeAgentId: omar });
    // Never routed, and nothing about routing written for it.
    expect(await eventsOf(id, 'routed')).toEqual([]);
  });
});

/**
 * A console edit on a ticket held for the router: the person has decided
 * where it goes (`endHold`), and what the hold kept back — the assignment and
 * the out-of-hours reply to the opening message — follows the rules.
 */
describe('updateTicket on a ticket held for routing', () => {
  beforeEach(async () => {
    await classifierApplies();
    await outOfHoursReply();
  });

  describe('the group case', () => {
    // Both ways round, so neither "always sent" nor "never sent" passes: the
    // reply is decided by the hours of the group the rule left the ticket in,
    // and never by those of the group the agent chose.
    it.each([
      ['closed', OPEN, SHUT, 1],
      ['open', SHUT, OPEN, 0],
    ] as const)(
      'ends the hold as manual, and assigns and replies in the group the rules left it in (%s)',
      async (_, chosenHours, ruledHours, acknowledged) => {
        const lina = await agent('Lina Care');
        const karim = await agent('Karim Courier');
        const omar = await agent('Omar Merchant');
        const care = await group('Customer Care', [lina]);
        const couriers = await group('Courier Jobs', [karim]);
        const merchants = await group('Merchant Care', [omar]);
        await keeps(couriers, 'Courier hours', chosenHours);
        await keeps(merchants, 'Merchant hours', ruledHours);
        await onUpdate('Courier jobs go to Merchant Care', inGroup(couriers), [
          { type: 'assign_group', groupId: merchants },
        ]);
        const id = await heldTicket(await mailbox(care, 'category'), care);

        expect(await edit(id, 'group', couriers)).toMatchObject({ error: null });

        // The person's decision is the group they chose; the rule's move
        // afterwards is the rule's, and decides nothing more.
        expect(await decisionOf(id)).toMatchObject({
          stage: 'decided',
          outcome: 'manual',
          fromGroupId: care,
          toGroupId: couriers,
          decidedByAgentId: signedIn.id,
        });
        expect(await eventsOf(id, 'routed')).toMatchObject([
          { actorAgentId: signedIn.id, data: { outcome: 'manual', to: couriers } },
        ]);
        // One assertion, so a failure names the holder and the reply together.
        const row = await ticketRow(id);
        expect({ ...row, acknowledged: (await acknowledgements(id)).length }).toMatchObject({
          groupId: merchants,
          assigneeAgentId: omar,
          acknowledged,
        });
        expect(row.routingDecidedAt).toBeInstanceOf(Date);
      },
    );
  });

  describe('the assignee case', () => {
    it('naming somebody ends the hold as the agent’s, and the held reply follows', async () => {
      await closedEverywhere();
      const lina = await agent('Lina Care');
      const hana = await agent('Hana Sales');
      const care = await group('Customer Care', [lina]);
      const id = await heldTicket(await mailbox(care, 'category'), care);

      // Somebody outside the group, so the rota could not have picked her.
      expect(await edit(id, 'assignee', hana)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'manual',
        toGroupId: care,
        decidedByAgentId: signedIn.id,
      });
      expect(await eventsOf(id, 'routed')).toMatchObject([
        { actorAgentId: signedIn.id, actorLabel: null, data: { outcome: 'manual', to: care } },
      ]);
      const row = await ticketRow(id);
      expect(row).toMatchObject({ groupId: care, assigneeAgentId: hana });
      expect(row.routingDecidedAt).toBeInstanceOf(Date);
      // Out of hours, and nobody has answered: the reply the hold kept back.
      expect(await acknowledgements(id)).toHaveLength(1);
    });

    // On a held ticket, which has no assignee, "Unassigned" is a no-op write:
    // ending the hold for it would assign the ticket in its default group and
    // send the default group's reply — the outcome the hold exists to prevent.
    it('"Unassigned" decides nothing, and the hold goes on', async () => {
      await closedEverywhere();
      const lina = await agent('Lina Care');
      const care = await group('Customer Care', [lina]);
      const id = await heldTicket(await mailbox(care, 'category'), care);

      expect(await edit(id, 'assignee', '')).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({
        stage: 'holding',
        outcome: null,
        decidedByAgentId: null,
      });
      expect(await eventsOf(id, 'routed')).toEqual([]);
      expect(await ticketRow(id)).toMatchObject({
        groupId: care,
        assigneeAgentId: null,
        routingDecidedAt: null,
      });
      expect(await acknowledgements(id)).toEqual([]);
    });

    // The rules see the assignment before the reply is told whose hours it
    // speaks for: here one moves the ticket out of a group that is open into
    // one that is shut, and the customer is told the office is closed.
    it('pays the held reply after the rules, on the hours of the group they left it in', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Merchant');
      const care = await group('Customer Care', [lina]);
      const merchants = await group('Merchant Care', [omar]);
      await keeps(care, 'Care hours', OPEN);
      await keeps(merchants, 'Merchant hours', SHUT);
      await onUpdate('Care goes to Merchant Care', inGroup(care), [
        { type: 'assign_group', groupId: merchants },
      ]);
      const id = await heldTicket(await mailbox(care, 'category'), care);

      expect(await edit(id, 'assignee', lina)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({ outcome: 'manual', toGroupId: care });
      expect(await ticketRow(id)).toMatchObject({ groupId: merchants, assigneeAgentId: lina });
      expect(await acknowledgements(id)).toHaveLength(1);
    });

    // A reply is no decision the live mode would have seen on a shadow row
    // (`decidesShadow`), but a person choosing who answers the ticket is: it
    // is the `manual` the shadow week is read for.
    it('on a ticket a shadow channel only watches, records the would-be manual', async () => {
      const lina = await agent('Lina Care');
      const hana = await agent('Hana Sales');
      const care = await group('Customer Care', [lina]);
      const id = await heldTicket(await mailbox(care, 'category_shadow'), care, { shadow: true });
      // Nothing holds a shadow ticket: the creation pass's rota assigns it.
      expect((await assignConversation(id)).assignedTo).toBe(lina);

      expect(await edit(id, 'assignee', hana)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({
        shadow: true,
        stage: 'decided',
        outcome: 'manual',
        toGroupId: care,
        decidedByAgentId: signedIn.id,
      });
      // Only watched: no `routed` line on the page, and no hold on the ticket.
      expect(await eventsOf(id, 'routed')).toEqual([]);
      expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: hana, routingDecidedAt: null });
    });
  });

  describe('the category case', () => {
    // The router runs the `on_update` rules itself (phase two), so the
    // console's own pass after the edit would be a second one: a rule that
    // writes on every pass writes twice, and one keyed on the category runs
    // again on a ticket the router has already finished with.
    it('routes the ticket as the person’s decision and runs the rules once', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      await onUpdate('Every update is urgent', { all: [] }, [
        { type: 'set_priority', value: 'urgent' },
      ]);
      const id = await heldTicket(await mailbox(care, 'category'), care);

      expect(await edit(id, 'category', salesCategory)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'category',
        fromGroupId: care,
        toGroupId: sales,
        categoryId: salesCategory,
        decidedByAgentId: signedIn.id,
        decidedByLabel: 'agent',
      });
      const row = await ticketRow(id);
      expect(row).toMatchObject({ groupId: sales, assigneeAgentId: omar });
      expect(row.routingDecidedAt).toBeInstanceOf(Date);
      expect(await eventsOf(id, 'priority_changed')).toEqual([
        {
          actorAgentId: null,
          actorLabel: 'automation:Every update is urgent',
          data: { to: 'urgent' },
        },
      ]);
    });
  });
});
