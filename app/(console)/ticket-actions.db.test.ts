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
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { routeNow } from '@/lib/routing/apply';
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

const { handToGroup, updateTicket } = await import('./ticket-actions');

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

async function onUpdate(name: string, conditions: unknown, actions: unknown[], position = 0) {
  const [row] = await db
    .insert(automationRules)
    .values({ name, trigger: 'on_update', conditions, actions, position })
    .returning({ id: automationRules.id });
  return row!.id;
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

/** "Hand to <group>" as the button posts it: the group it named, and who the page showed holding the ticket. */
function handTo(conversationId: string, groupId: string, shownAssignee: string | null) {
  const data = new FormData();
  data.set('conversationId', conversationId);
  data.set('groupId', groupId);
  data.set('assigneeAgentId', shownAssignee ?? '');
  return handToGroup({ error: null }, data);
}

/** Resolves once `count` sessions wait on a lock, or once `stop()` says nobody will. */
async function untilWaitingOnLocks(count: number, stop: () => boolean): Promise<void> {
  for (let i = 0; i < 250 && !stop(); i++) {
    const [{ waiting }] = (await db.execute(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as [{ waiting: number }];
    if (waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Holds rule `ruleId`'s row from another transaction until released, so a
 * pass over the rules stops at that rule's `last_run_at` — after its actions,
 * before the next rule.
 */
async function holdRule(ruleId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holding = db.transaction(async (tx) => {
    await tx
      .select({ id: automationRules.id })
      .from(automationRules)
      .where(eq(automationRules.id, ruleId))
      .for('update');
    locked();
    await released;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await holding;
    },
  };
}

async function tagsOf(id: string) {
  const [row] = await db
    .select({ tags: conversations.tags })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.tags;
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

describe('handToGroup', () => {
  async function desk() {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Inbound Sales Team', [omar]);
    return { lina, omar, care, sales, salesCategory: await routeTo('sales', sales) };
  }

  // The page offered one click because it showed nobody holding the ticket;
  // Lina took it since. That click must not take it off her: it is refused,
  // and the page drawn again asks twice.
  it('refuses when somebody other than the assignee the page showed holds the ticket', async () => {
    const { lina, omar, care, sales, salesCategory } = await desk();
    const { id } = await ticket(care, { categoryId: salesCategory, assigneeAgentId: lina });

    expect(await handTo(id, sales, null)).toEqual({
      error:
        'Who holds this ticket has changed since the page loaded. Check who it is before handing it over.',
    });
    expect(await ticketRow(id)).toMatchObject({ groupId: care, assigneeAgentId: lina });

    expect(await handTo(id, sales, lina)).toMatchObject({ error: null });
    expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: omar });
  });

  it('says the ticket waits in the group’s queue when nobody there could be given it', async () => {
    const { lina, care } = await desk();
    const couriers = await group('Courier Jobs', [], { assignmentStrategy: 'manual' });
    const { id } = await ticket(care, {
      categoryId: await routeTo('courier_jobs', couriers),
      assigneeAgentId: lina,
    });

    expect(await handTo(id, couriers, lina)).toMatchObject({
      error: null,
      message:
        "Handed to Courier Jobs. Nobody there was given it, so it waits in the group's queue.",
    });
  });

  // The rota answers for the group the rules left the ticket in, so the
  // route group's queue is not where it waits.
  it('names the group a rule moved the ticket on to, as the queue it waits in', async () => {
    const { lina, care, sales, salesCategory } = await desk();
    const merchants = await group('Merchant Care', [], { assignmentStrategy: 'manual' });
    await onUpdate('Sales goes to Merchant Care', inGroup(sales), [
      { type: 'assign_group', groupId: merchants },
    ]);
    const { id } = await ticket(care, { categoryId: salesCategory, assigneeAgentId: lina });

    expect(await handTo(id, sales, lina)).toMatchObject({
      error: null,
      message:
        "Handed to Inbound Sales Team and then moved on to Merchant Care. Nobody there was given it, so it waits in that group's queue.",
    });
    expect(await ticketRow(id)).toMatchObject({ groupId: merchants, assigneeAgentId: null });
  });

  // A ticket a rule resolved is in nobody's queue; the page drawn with the
  // answer shows its status.
  it('says nothing of a queue when a rule resolved the ticket', async () => {
    const { lina, care, sales, salesCategory } = await desk();
    await onUpdate('Sales is resolved on sight', inGroup(sales), [
      { type: 'set_status', category: 'resolved' },
    ]);
    const { id } = await ticket(care, { categoryId: salesCategory, assigneeAgentId: lina });

    const answer = await handTo(id, sales, lina);
    expect(answer).toMatchObject({ error: null });
    expect(answer).not.toHaveProperty('message');
  });
});

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

    // Jev's answer routed the ticket a moment ago, and its pass over the rules
    // read the ticket filed as Sales; the agent files it as merchant work
    // while that pass is still going. The router is part-way through
    // (`in_flight`), its pass will never see the new category, and nothing
    // runs the rules again once it ends the hold — so the edit runs its own
    // pass, or the rule keyed on merchant work never fires. The first rule's
    // row is held from outside to stop the router's pass between its two
    // rules.
    it('runs its own pass when it meets a decision part-way through, whose rules read the old category', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      const [merchantWork] = await db
        .select({ id: ticketCategories.id })
        .from(ticketCategories)
        .where(eq(ticketCategories.key, 'merchant_support'));
      const first = await onUpdate('Seen', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
      await onUpdate(
        'Merchant work',
        { field: 'category.id', op: 'eq', value: merchantWork!.id },
        [{ type: 'add_tags', tags: ['merchant-work'] }],
        1,
      );
      const id = await heldTicket(await mailbox(care, 'category'), care);
      expect(
        (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
      ).toBe('changed');

      const rule = await holdRule(first);
      let routing: Promise<unknown> = Promise.resolve();
      let editing: Promise<unknown> = Promise.resolve();
      try {
        routing = routeNow(id, { label: 'jev:category' });
        await untilWaitingOnLocks(1, () => false);
        // Phase one has decided and committed; the pass is held on the first rule.
        expect(await decisionOf(id)).toMatchObject({ stage: 'holding', outcome: 'category' });

        let edited = false;
        editing = edit(id, 'category', merchantWork!.id).finally(() => (edited = true));
        // The edit's own pass stops at the same rule; one that ran no pass returns.
        await untilWaitingOnLocks(2, () => edited);
      } finally {
        await rule.release();
      }
      expect(await routing).toBe('decided');
      expect(await editing).toMatchObject({ error: null });

      expect(await tagsOf(id)).toEqual(expect.arrayContaining(['seen', 'merchant-work']));
      // The router's decision stands: the agent relabelled a routed ticket.
      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'category',
        toGroupId: sales,
        decidedByLabel: 'jev:category',
      });
      expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: omar });
    });
  });
});
