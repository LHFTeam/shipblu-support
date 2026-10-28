import { and, asc, eq, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
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
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { cairo } from '@/lib/testing/time';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { afterHoldEnded } from './after-hold';
import { routeNow, settleRouting } from './apply';
import { beginRouting } from './begin';
import { endHold } from './end-hold';
import { startRouting } from './start';

/**
 * The router's decision against Postgres (`plans/ticket-category-routing.md`,
 * decision 5): the two phases with the rules between them, what ends a hold
 * early, and the out-of-hours reply the hold kept back. `begin.db.test.ts` has
 * the insert and the creation pass; `settle.db.test.ts` the window's end, the
 * recovery of a decision that died between its phases, the SLA policy a
 * decision leaves, and a shadow row.
 *
 * A ticket here is built from rows and started through `startRouting` itself,
 * then begun through `beginRouting`, so it is in exactly the state the creation
 * pass leaves a held ticket in — on the real clock, because the automation
 * engine and the classifier assign on it and a window opened on another day
 * would have lapsed for them. The groups keep no hours for assignment
 * (`assignWithinHoursOnly: false`), so who is picked never depends on the hour
 * the test runs; the out-of-hours reply's tests set a calendar of their own,
 * or hand the router its clock.
 *
 * Every best-effort step here logs instead of throwing, so a failure inside
 * one would read as "nothing happened": a test fails on any error logged it
 * did not ask for.
 */

withCleanDatabase();

const MINUTE = 60_000;
/** Closed under the seeded week (Sunday to Thursday, 09:00 to 17:00). */
const NIGHT = cairo('2026-10-21T23:00');

let errors: MockInstance;
let errorsExpected = false;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  errorsExpected = false;
  await classifier('apply');
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  if (!errorsExpected) expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

/** The classifier's switch, which routing starts only under (`routingStartFor`). */
async function classifier(mode: 'off' | 'shadow' | 'apply', windowMinutes = 5): Promise<void> {
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, ${mode}, 0.6, ${windowMinutes})
    on conflict (id) do update
      set mode = excluded.mode, routing_window_minutes = excluded.routing_window_minutes`);
  forgetCategoryAiSettings();
}

let people = 0;

async function agent(name: string): Promise<string> {
  people += 1;
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `agent${people}@shipblu.test`,
      presence: 'online',
      lastSeenAt: new Date(),
    })
    .returning({ id: agents.id });
  return row!.id;
}

/** A group that assigns round robin at any hour, with these members. */
async function group(
  name: string,
  members: string[],
  values: Partial<typeof groups.$inferInsert> = {},
): Promise<string> {
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

/** A calendar a group can keep, which the assignment and the reply then read. */
async function calendar(name: string, schedule: ReturnType<typeof week>): Promise<string> {
  const [row] = await db
    .insert(businessHours)
    .values({ name, schedule })
    .returning({ id: businessHours.id });
  forgetHoursCatalog();
  return row!.id;
}

async function keeps(groupId: string, hoursId: string): Promise<void> {
  await db.update(groups).set({ businessHoursId: hoursId }).where(eq(groups.id, groupId));
  forgetHoursCatalog();
}

/** The seeded default calendar, shut for good: every group without its own is closed now. */
async function closedEverywhere(): Promise<void> {
  await db.update(businessHours).set({ schedule: SHUT }).where(eq(businessHours.isDefault, true));
  forgetHoursCatalog();
}

/** A seeded category, pointed at `routeGroupId`. */
async function routeTo(key: string, routeGroupId: string | null): Promise<string> {
  const [row] = await db
    .update(ticketCategories)
    .set({ routeGroupId })
    .where(eq(ticketCategories.key, key))
    .returning({ id: ticketCategories.id });
  return row!.id;
}

async function mailbox(
  defaultGroupId: string,
  routingMode: 'default_group' | 'category_shadow' | 'category' = 'category',
): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type: 'email', name: 'Support mail', config: {}, defaultGroupId, routingMode })
    .returning({ id: channels.id });
  return row!.id;
}

async function status(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function rule(
  trigger: 'on_create' | 'on_update',
  name: string,
  conditions: unknown,
  actions: unknown[],
  position = 0,
): Promise<void> {
  await db.insert(automationRules).values({ name, trigger, conditions, actions, position });
}

const always = { all: [] };
const inCategory = (categoryId: string) => ({ field: 'category.id', op: 'eq', value: categoryId });

/** The out-of-hours acknowledgement, on every channel and group. */
async function outOfHoursReply(): Promise<void> {
  await db
    .insert(autoResponses)
    .values({ bodyEn: 'Thanks — we are closed, and will reply when we open.' });
}

type Held = { id: string; messageId: string };

/**
 * A ticket on `channelId`'s mail, started as the insert starts one and begun as
 * the creation pass begins it — `holding`, with no category — unless `stage`
 * says to stop at the insert.
 */
async function heldTicket(
  channelId: string,
  groupId: string,
  {
    shadow = false,
    stage = 'holding',
    opened = new Date(),
    createdAt = opened,
  }: {
    shadow?: boolean;
    stage?: 'pending' | 'holding';
    opened?: Date;
    createdAt?: Date;
  } = {},
): Promise<Held> {
  people += 1;
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: `amira${people}@customer.example` })
    .returning({ id: contacts.id });
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      channelId,
      groupId,
      statusId: await status('Open'),
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      createdAt,
      lastMessageAt: opened,
      lastCustomerMessageAt: opened,
    })
    .returning({ id: conversations.id });
  const id = ticket!.id;
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: id,
      direction: 'inbound',
      kind: 'reply',
      bodyText: 'Hello, my parcel has not arrived.',
      createdAt: opened,
    })
    .returning({ id: messages.id });
  await db.transaction((tx) =>
    startRouting(
      tx,
      { start: shadow ? 'shadow' : 'live', channelId, windowMinutes: 5 },
      { conversationId: id, messageId: message!.id, groupId },
      opened,
    ),
  );
  if (stage === 'holding') expect(await beginRouting(id)).toBe('continue');
  return { id, messageId: message!.id };
}

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      groupId: conversations.groupId,
      assigneeAgentId: conversations.assigneeAgentId,
      categoryId: conversations.categoryId,
      routingWindowEndsAt: conversations.routingWindowEndsAt,
      routingDecidedAt: conversations.routingDecidedAt,
      slaPolicyId: conversations.slaPolicyId,
      firstResponseDueAt: conversations.firstResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function decision(id: string) {
  const [row] = await db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, id));
  return row!;
}

async function events(id: string, type: string) {
  return db
    .select({
      actorAgentId: conversationEvents.actorAgentId,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
    .orderBy(asc(conversationEvents.createdAt));
}

/** The out-of-hours acknowledgements sent on the ticket. */
async function acknowledgements(id: string) {
  return db
    .select({ bodyText: messages.bodyText })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, id),
        eq(messages.direction, 'outbound'),
        sql`${messages.meta}->>'autoResponse' is not null`,
      ),
    );
}

/**
 * The record every decision ends in: decided, with its outcome and when, and —
 * on a live row — the hold over and exactly one `routed` event saying so.
 */
async function expectDecided(id: string, outcome: string) {
  const row = await decision(id);
  expect(row).toMatchObject({ stage: 'decided', outcome });
  expect(row.decidedAt).toBeInstanceOf(Date);
  const routed = await events(id, 'routed');
  if (row.shadow) {
    expect(routed).toEqual([]);
    expect((await ticketRow(id)).routingDecidedAt).toBeNull();
  } else {
    expect(routed.map((event) => event.data.outcome)).toEqual([outcome]);
    expect((await ticketRow(id)).routingDecidedAt).toBeInstanceOf(Date);
  }
  return row;
}

async function tags(id: string): Promise<string[]> {
  const [row] = await db
    .select({ tags: conversations.tags })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.tags;
}

/** Jev filing the ticket, as the classifier's write leaves it. */
async function jevFiles(id: string, categoryId: string): Promise<void> {
  expect((await setConversationCategory(id, categoryId, { label: 'jev:category' })).outcome).toBe(
    'changed',
  );
}

/** Three teams: the mailbox's own, Sales, and Merchant Care, one agent each. */
async function teams() {
  const home = { agent: await agent('Hana') };
  const sales = { agent: await agent('Samir') };
  const care = { agent: await agent('Mona') };
  const homeGroup = await group('Customer Care', [home.agent]);
  const salesGroup = await group('Sales', [sales.agent]);
  const careGroup = await group('Merchant Care', [care.agent]);
  return {
    home: { ...home, group: homeGroup },
    sales: { ...sales, group: salesGroup },
    care: { ...care, group: careGroup },
    channel: await mailbox(homeGroup),
  };
}

// --- The decision -----------------------------------------------------------

describe('routeNow, a held ticket Jev has filed', () => {
  it('moves it to the route group, assigns it there, and says why on the timeline', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    const row = await expectDecided(id, 'category');
    expect(row).toMatchObject({
      fromGroupId: t.home.group,
      toGroupId: t.sales.group,
      categoryId: sales,
      decidedByLabel: 'jev:category',
    });
    expect(row.phaseOneAt).toBeInstanceOf(Date);
    expect((await events(id, 'routed'))[0]).toMatchObject({
      actorAgentId: null,
      actorLabel: 'routing',
      data: {
        outcome: 'category',
        by: 'jev:category',
        from: t.home.group,
        fromName: 'Customer Care',
        to: t.sales.group,
        toName: 'Sales',
        moved: true,
        key: 'sales',
      },
    });
  });

  it('answers none once decided, which is how a late answer leaves the ticket where it is', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    expect(await settleRouting(id)).toBe('decided');
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('none');
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
    });
    await expectDecided(id, 'fallback');
  });

  it('leaves the hold for the window’s end when its phase one fails', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    const spy = vi
      .spyOn(PgDatabase.prototype, 'transaction')
      .mockImplementationOnce(() => Promise.reject(new Error('the connection was lost')));
    expect(await routeNow(id, { label: 'jev:category' })).toBe('failed');
    spy.mockRestore();

    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      `[routing] could not route ${id}`,
    ]);
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null, phaseOneAt: null });
    expect(await ticketRow(id)).toMatchObject({ groupId: t.home.group, routingDecidedAt: null });

    // The window's end decides on the same category.
    expect(await settleRouting(id)).toBe('decided');
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'settle_routing' });
  });

  it('decides once when a person’s edit races Jev’s answer', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Jev's phase one holds the row; the person's waits on it, and then finds
    // the decision written and in flight.
    const hold = holdNextTransaction('after');
    const jev = routeNow(id, { label: 'jev:category' });
    await hold.atHold;
    const person = routeNow(id, { agentId: lead, label: 'agent' });
    await untilWaitingOnALock(db);
    hold.release();

    expect(await jev).toBe('decided');
    expect(await person).toBe('in_flight');
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({
      decidedByLabel: 'jev:category',
      decidedByAgentId: null,
    });
  });

  it('answers none for a ticket that never entered routing', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await db.delete(routingDecisions).where(eq(routingDecisions.conversationId, id));
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('none');
  });
});

describe('the two-phase order', () => {
  it('runs the rules keyed on the category before assigning, from the group they leave', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    // "Sales on this mailbox is a merchant asking": the exception a rule decides.
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    // Assigned the other way round, Samir in Sales would hold a Merchant Care
    // ticket: `assign_group` never touches an assignee.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    // The record is the router's: where it sent the ticket, which the rule then
    // overruled on the timeline after it.
    expect(await expectDecided(id, 'category')).toMatchObject({ toGroupId: t.sales.group });
    expect((await events(id, 'group_changed')).map((e) => e.data.to)).toEqual([t.care.group]);
  });

  it('keeps the hold through the whole pass, so a rule between two moves assigns nobody', async () => {
    const t = await teams();
    const keyAccounts = { agent: await agent('Karim') };
    const keyGroup = await group('Key Accounts', [keyAccounts.agent]);
    const sales = await routeTo('sales', t.sales.group);
    await rule(
      'on_update',
      'Merchant sales to Merchant Care',
      inCategory(sales),
      [{ type: 'assign_group', groupId: t.care.group }],
      0,
    );
    // "Assign within the current group", which a held ticket waits on like any
    // other assignment.
    await rule(
      'on_update',
      'Assign in the group',
      always,
      [{ type: 'auto_assign', groupId: null, strategy: 'group_default' }],
      1,
    );
    await rule(
      'on_update',
      'Merchant sales are key accounts',
      inCategory(sales),
      [{ type: 'assign_group', groupId: keyGroup }],
      2,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    // Had the first rule's move ended the hold, the second would have handed
    // the ticket to Mona in Merchant Care, and the third moved it away from her.
    expect(await ticketRow(id)).toMatchObject({
      groupId: keyGroup,
      assigneeAgentId: keyAccounts.agent,
    });
    expect(await events(id, 'assigned')).toHaveLength(1);
    const row = await expectDecided(id, 'category');
    expect(row.decidedByLabel).toBe('jev:category');
  });

  it('still runs the category’s rules on a no_route_for_category decision', async () => {
    const t = await teams();
    const sales = await routeTo('sales', null);
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await expectDecided(id, 'no_route_for_category')).toMatchObject({
      toGroupId: t.home.group,
    });
    expect((await events(id, 'routed'))[0]!.data).toMatchObject({ moved: false });
  });

  it.each([
    ['released', 'the channel stopped routing'],
    ['taken', 'somebody holds it'],
  ] as const)(
    'runs the category’s rules on a %s decision too, the pass Jev gave up (%s)',
    async (outcome, _why) => {
      const t = await teams();
      const sales = await routeTo('sales', t.sales.group);
      await rule('on_update', 'Tag sales', inCategory(sales), [
        { type: 'add_tags', tags: ['sales'] },
      ]);
      const { id } = await heldTicket(t.channel, t.home.group);
      await jevFiles(id, sales);
      if (outcome === 'released') {
        await db
          .update(channels)
          .set({ routingMode: 'default_group' })
          .where(eq(channels.id, t.channel));
      } else {
        await db
          .update(conversations)
          .set({ assigneeAgentId: t.home.agent })
          .where(eq(conversations.id, id));
      }

      expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

      expect(await tags(id)).toEqual(['sales']);
      expect(await ticketRow(id)).toMatchObject({
        groupId: t.home.group,
        assigneeAgentId: t.home.agent,
      });
      await expectDecided(id, outcome);
    },
  );

  it('runs no rules for a ticket nobody may work, and only ends its hold', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await db
      .update(conversations)
      .set({ statusId: await status('Closed') })
      .where(eq(conversations.id, id));

    expect(await routeNow(id, { label: 'jev:category' })).toBe('none');

    expect(await tags(id)).toEqual([]);
    expect(await ticketRow(id)).toMatchObject({ groupId: t.home.group, assigneeAgentId: null });
    await expectDecided(id, 'not_open');
  });

  it('assigns nobody between phases one and three', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    await interruptedAfterPhaseOne(id);

    // Decided and moved, and still held: phase three is what ends the hold.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: 'category' });

    expect(await assignConversation(id)).toMatchObject({
      assignedTo: null,
      reason: 'awaiting_route',
    });
    // Nor a rule's assignment in the group the ticket is in.
    await rule('on_update', 'Assign in the group', always, [
      { type: 'auto_assign', groupId: null, strategy: 'group_default' },
    ]);
    await afterTicketUpdate(id);
    expect((await ticketRow(id)).assigneeAgentId).toBeNull();
    expect(await events(id, 'assignment_skipped')).toEqual([]);
    // And another caller finds the decision in flight rather than making a second.
    expect(await routeNow(id, { label: 'agent' })).toBe('in_flight');
    expect(await events(id, 'routed')).toHaveLength(1);
  });
});

// --- What ends a hold early -------------------------------------------------

describe('what ends a hold early', () => {
  it('nothing, on a ticket that never entered routing — so the console calls it on any', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);
    await db.delete(routingDecisions).where(eq(routingDecisions.conversationId, id));
    await db
      .update(conversations)
      .set({ routingWindowEndsAt: null })
      .where(eq(conversations.id, id));

    expect(await db.transaction((tx) => endHold(tx, id, 'manual', { label: 'agent' }))).toBe(false);

    expect(await ticketRow(id)).toMatchObject({ routingDecidedAt: null });
    expect(await events(id, 'routed')).toEqual([]);
  });

  it('a rule naming the group the ticket is in does not', async () => {
    const t = await teams();
    await rule('on_update', 'Mail to Customer Care', always, [
      { type: 'assign_group', groupId: t.home.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);

    await afterTicketUpdate(id);

    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null });
    expect(await events(id, 'routed')).toEqual([]);
    expect(await events(id, 'group_changed')).toEqual([]);
  });

  it('a rule naming an agent does, as rule, and the window’s end records nothing new', async () => {
    const t = await teams();
    await rule('on_update', 'VIP to Samir', always, [
      { type: 'assign_agent', agentId: t.sales.agent },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);

    await afterTicketUpdate(id);

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.sales.agent);
    const row = await expectDecided(id, 'rule');
    expect(row).toMatchObject({
      decidedByLabel: 'automation:VIP to Samir',
      toGroupId: t.home.group,
      phaseOneAt: null,
    });
    expect((await events(id, 'routed'))[0]).toMatchObject({
      actorLabel: 'automation:VIP to Samir',
      data: { outcome: 'rule', moved: false },
    });

    expect(await settleRouting(id)).toBe('none');
    expect(await decision(id)).toEqual(row);
    await expectDecided(id, 'rule');
  });

  it('a rule moving the ticket to another group does, and it is assigned there', async () => {
    const t = await teams();
    await rule('on_update', 'Mail to Merchant Care', always, [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);

    await afterTicketUpdate(id);

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await expectDecided(id, 'rule')).toMatchObject({ toGroupId: t.care.group });
    expect((await events(id, 'routed'))[0]!.data).toMatchObject({ moved: true });
  });

  it('a person’s category edit during the hold routes the ticket now', async () => {
    // The lib half of the console's category case: the edit, then `routeNow`
    // in the agent's name, instead of the update pass.
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);

    await setConversationCategory(id, sales, { agentId: lead });
    expect(await routeNow(id, { agentId: lead, label: 'agent' })).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({
      decidedByAgentId: lead,
      decidedByLabel: 'agent',
      // A person's category is no answer of Jev's, so it carries no probability.
      probability: null,
    });
  });

  it('a person moving the ticket does, as manual, and it is assigned where they put it', async () => {
    // The lib half of the console's group case: the move and `endHold` in one
    // transaction, then what the hold kept back.
    const t = await teams();
    const lead = await agent('Laila');
    const { id } = await heldTicket(t.channel, t.home.group);

    const ended = await db.transaction(async (tx) => {
      await tx.update(conversations).set({ groupId: t.care.group }).where(eq(conversations.id, id));
      return endHold(tx, id, 'manual', { agentId: lead });
    });
    expect(ended).toBe(true);
    await afterHoldEnded(id);

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.care.agent);
    expect(await expectDecided(id, 'manual')).toMatchObject({
      decidedByAgentId: lead,
      toGroupId: t.care.group,
    });
    expect((await events(id, 'routed'))[0]).toMatchObject({
      actorAgentId: lead,
      actorLabel: null,
      data: { outcome: 'manual', from: t.home.group, to: t.care.group, moved: true },
    });
    // Called again — a retried action — it finds nothing undecided.
    expect(await db.transaction((tx) => endHold(tx, id, 'manual', { agentId: lead }))).toBe(false);
    expect(await events(id, 'routed')).toHaveLength(1);
  });

  it('an agent’s reply does, as manual', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    await storeAgentReply(id, 'email', {
      authorAgentId: t.home.agent,
      bodyText: 'Looking into it now.',
      bodyHtml: '<p>Looking into it now.</p>',
    });

    expect(await expectDecided(id, 'manual')).toMatchObject({ decidedByAgentId: t.home.agent });
    // Assigned in the group it was in, which is where the person answered it.
    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
  });

  it('a person decides nothing by ending the hold after phase one wrote the router’s', async () => {
    errorsExpected = true;
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);

    await db.transaction(async (tx) => {
      await tx.update(conversations).set({ assigneeAgentId: lead }).where(eq(conversations.id, id));
      return endHold(tx, id, 'manual', { agentId: lead });
    });

    // The router's decision keeps its name; the person's assignment stands.
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'jev:category' });
    expect((await ticketRow(id)).assigneeAgentId).toBe(lead);
  });
});

/**
 * Route the ticket, and lose the connection before phase three commits: phase
 * one's transaction runs, and the one that ends the hold fails. With no rules
 * owed in between, those are `routeNow`'s first two.
 */
async function interruptedAfterPhaseOne(id: string): Promise<void> {
  const transaction = PgDatabase.prototype.transaction;
  const spy = vi
    .spyOn(PgDatabase.prototype, 'transaction')
    .mockImplementationOnce(function (this: PgDatabase<never>, run, config) {
      return transaction.call(this, run, config) as never;
    })
    .mockImplementationOnce(() => Promise.reject(new Error('the connection was lost')));
  expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');
  spy.mockRestore();
  expect(await decision(id)).toMatchObject({ stage: 'holding' });
}

// --- The held reply ---------------------------------------------------------

describe('the held out-of-hours reply', () => {
  beforeEach(async () => {
    // Shut whatever the clock says, so a path that sends on the real clock —
    // the engine's, a person's — answers the same at any hour.
    await closedEverywhere();
    await outOfHoursReply();
  });

  it('waits while the ticket is held', async () => {
    const t = await teams();
    const held = await heldTicket(t.channel, t.home.group);

    await maybeSendAutoResponse({ conversationId: held.id, messageId: held.messageId });

    expect(await acknowledgements(held.id)).toEqual([]);
    // Nor did it spend the closed stretch the reply is owed in.
    const [row] = await db
      .select({ autoRespondedAt: conversations.autoRespondedAt })
      .from(conversations)
      .where(eq(conversations.id, held.id));
    expect(row!.autoRespondedAt).toBeNull();
  });

  it('goes once the window ends without a category, and never twice', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    expect(await settleRouting(id)).toBe('decided');
    expect(await acknowledgements(id)).toHaveLength(1);

    expect(await settleRouting(id)).toBe('none');
    await afterHoldEnded(id);
    expect(await acknowledgements(id)).toHaveLength(1);
    await expectDecided(id, 'fallback');
  });

  it('goes once when the channel stopped routing during the hold', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);
    await db
      .update(channels)
      .set({ routingMode: 'default_group' })
      .where(eq(channels.id, t.channel));

    expect(await settleRouting(id)).toBe('decided');

    expect(await acknowledgements(id)).toHaveLength(1);
    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
    await expectDecided(id, 'released');
  });

  it('goes once when Jev’s answer routes the ticket', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');
    expect(await settleRouting(id)).toBe('none');

    expect(await acknowledgements(id)).toHaveLength(1);
    await expectDecided(id, 'category');
  });

  it('goes once when the creation pass routes on a category already settled', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });
    await jevFiles(id, sales);

    expect(await beginRouting(id)).toBe('routed');

    expect(await acknowledgements(id)).toHaveLength(1);
    await expectDecided(id, 'category');
  });

  it('goes once when a rule ends the hold', async () => {
    const t = await teams();
    await rule('on_update', 'Mail to Merchant Care', always, [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);

    await afterTicketUpdate(id);
    expect(await settleRouting(id)).toBe('none');

    expect(await acknowledgements(id)).toHaveLength(1);
    await expectDecided(id, 'rule');
  });

  it('goes once when a person moves the ticket', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const { id } = await heldTicket(t.channel, t.home.group);

    await db.transaction(async (tx) => {
      await tx.update(conversations).set({ groupId: t.care.group }).where(eq(conversations.id, id));
      return endHold(tx, id, 'manual', { agentId: lead });
    });
    await afterHoldEnded(id);
    expect(await settleRouting(id)).toBe('none');

    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('does not go after an agent answered during the hold', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    await storeAgentReply(id, 'email', {
      authorAgentId: t.home.agent,
      bodyText: 'Looking into it now.',
      bodyHtml: '<p>Looking into it now.</p>',
    });
    expect(await settleRouting(id)).toBe('none');
    await afterHoldEnded(id);

    expect(await acknowledgements(id)).toEqual([]);
  });

  it('does not answer the customer writing again in the stretch the agent answered in', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);
    await storeAgentReply(id, 'email', {
      authorAgentId: t.home.agent,
      bodyText: 'Looking into it now.',
      bodyHtml: '<p>Looking into it now.</p>',
    });

    // Three minutes later, a second mail: the reply branch's acknowledgement.
    const later = new Date(Date.now() + 3 * MINUTE);
    const [next] = await db
      .insert(messages)
      .values({
        conversationId: id,
        direction: 'inbound',
        kind: 'reply',
        bodyText: 'Any news?',
        createdAt: later,
      })
      .returning({ id: messages.id });
    await db
      .update(conversations)
      .set({ lastCustomerMessageAt: later, lastMessageAt: later })
      .where(eq(conversations.id, id));
    await maybeSendAutoResponse({ conversationId: id, messageId: next!.id }, later);

    expect(await acknowledgements(id)).toEqual([]);
  });

  it('is sent on the final group’s calendar, after the rules moved the ticket', async () => {
    const t = await teams();
    // The mailbox's team and Sales are open; Merchant Care, where the rule
    // sends it, is shut.
    const open = await calendar('Open round the clock', OPEN);
    await keeps(t.home.group, open);
    await keeps(t.sales.group, open);
    await keeps(t.care.group, await calendar('Never open', SHUT));
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect((await ticketRow(id)).groupId).toBe(t.care.group);
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('is not sent when the final group is open, though the one it arrived in is shut', async () => {
    const t = await teams();
    // Shut by default: Customer Care and Sales keep no calendar of their own.
    await keeps(t.care.group, await calendar('Open round the clock', OPEN));
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(await acknowledgements(id)).toEqual([]);
  });

  it('is never sent on a ticket resolved during the hold', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);
    await db
      .update(conversations)
      .set({ statusId: await status('Resolved') })
      .where(eq(conversations.id, id));

    expect(await settleRouting(id)).toBe('none');

    expect(await acknowledgements(id)).toEqual([]);
    expect((await ticketRow(id)).assigneeAgentId).toBeNull();
    await expectDecided(id, 'not_open');
  });
});

describe('the held reply, on the clock the router is handed', () => {
  // The seeded Cairo week. The router hands its own clock to the reply, so
  // what it says is about the instant it ends the hold, not the test's.
  beforeEach(outOfHoursReply);

  it('is sent when the window ends at night', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    expect(await settleRouting(id, NIGHT)).toBe('decided');

    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('is not sent when the window ends in working hours', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    expect(await settleRouting(id, cairo('2026-10-21T11:00'))).toBe('decided');

    expect(await acknowledgements(id)).toEqual([]);
  });

  it('is sent when Jev’s answer routes the ticket at night', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' }, NIGHT)).toBe('decided');

    expect(await acknowledgements(id)).toHaveLength(1);
  });
});
