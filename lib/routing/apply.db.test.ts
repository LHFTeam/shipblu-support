import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  slaPolicies,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { setConversationCategory, setConversationCategoryOn } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { cairo } from '@/lib/testing/time';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { afterHoldEnded } from './after-hold';
import { routeNow, settleRouting, type RouteResult } from './apply';
import { beginRouting } from './begin';
import { endHold } from './end-hold';
import { routingWindowValues, startRouting } from './start';
import { deferToRouter } from './state';

/**
 * The router's decision against Postgres (`plans/ticket-category-routing.md`,
 * decision 5): the two phases with the rules between them, what ends a hold
 * early, and the out-of-hours reply the hold kept back. `begin.db.test.ts` has
 * the insert and the creation pass; `settle.db.test.ts` the window's end, the
 * recovery of a decision that died between its phases, the SLA policy a
 * decision leaves, and a shadow row.
 *
 * A ticket here is built from rows — its window on the insert, through
 * `routingWindowValues` — started through `startRouting` itself, then begun
 * through `beginRouting`, so it is in exactly the state the creation pass
 * leaves a held ticket in — on the real clock, because the automation
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
let warnings: MockInstance;
let errorsExpected = false;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  const plan = { start: shadow ? 'shadow' : 'live', channelId, windowMinutes: 5 } as const;
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
      ...routingWindowValues(plan, {}, opened),
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
    startRouting(tx, plan, { conversationId: id, messageId: message!.id, groupId }, opened),
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

/** How many times a rule's `add_tags` has run on the ticket: one event each. */
async function tagged(id: string): Promise<number> {
  return (await events(id, 'tagged')).length;
}

/**
 * The ticket's lines of these types in the order the page draws them, by
 * `created_at`: whether the rules ran before anybody was assigned, and the
 * decision after what it decided on.
 */
async function timeline(
  id: string,
  types: string[] = ['routed', 'group_changed', 'tagged', 'assigned'],
): Promise<string[]> {
  const rows = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, types)))
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
  return rows.map((row) => row.type);
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

  // The window's job begins its transaction, and a person's category edit
  // takes the ticket's lock and commits before phase one reaches it. Stamped
  // with the transaction's start, the `routed` line sorted before the
  // `category_changed` it decided on, and the page told it backwards.
  it('records its decision after the category it decided on, though its transaction began first', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);

    const held = holdNextTransaction('before');
    const settling = settleRouting(id);
    await held.atHold;
    expect((await setConversationCategory(id, sales, { agentId: lead })).outcome).toBe('changed');
    held.release();
    expect(await settling).toBe('decided');

    expect(await timeline(id, ['category_changed', 'routed', 'assigned'])).toEqual([
      'category_changed',
      'routed',
      'assigned',
    ]);
    expect(await expectDecided(id, 'category')).toMatchObject({
      categoryId: sales,
      decidedByLabel: 'settle_routing',
    });
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

  it('gives its pass up on a ticket resolved since its phase one, and only ends the hold', async () => {
    // Resolved in the moment between phase one's commit and the claim, with
    // no window's job in between to find it: the rules would run on a ticket
    // nobody may work, and a category's `send_reply` reach its customer.
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag everything', always, [{ type: 'add_tags', tags: ['ran'] }]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(
      await routeBetweenPhases(id, async () => {
        await db
          .update(conversations)
          .set({ statusId: await status('Resolved'), resolvedAt: new Date() })
          .where(eq(conversations.id, id));
      }),
    ).toBe('decided');

    // No rule ran on it, nobody was given it, and nothing was said.
    expect(await tags(id)).toEqual([]);
    expect(await ticketRow(id)).toMatchObject({ groupId: t.sales.group, assigneeAgentId: null });
    expect(await acknowledgements(id)).toEqual([]);
    // The decision stands and its hold is over; the pass claimed, never run.
    const row = await expectDecided(id, 'category');
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
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

  it('runs the rules once when phase three fails, and the window’s job only ends the hold', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // `add_tags` opens no transaction, so the second is phase three's.
    await interruptedAfterPhaseOne(id);
    expect(await tagged(id)).toBe(1);
    const row = await decision(id);
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);

    // The window's job, once the minute is up: the pass is done, so it ends
    // the hold and pays what the hold owed, and runs no rule again.
    await db
      .update(routingDecisions)
      .set({ phaseOneAt: new Date(Date.now() - 2 * MINUTE) })
      .where(eq(routingDecisions.conversationId, id));
    expect(await settleRouting(id)).toBe('decided');

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    await expectDecided(id, 'category');
  });

  it('ends no hold, and runs nothing, for a caller whose claim on the rules is lost', async () => {
    // A caller that stalled a minute after its phase one, and the window's job
    // that took the decision over meanwhile and claimed the pass: ending the
    // hold here would let assignment beat a rule the claimant has still to run.
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Decided: the decision is written, and the claimant runs the rules on it.
    expect(
      await routeBetweenPhases(id, async () => {
        await db
          .update(routingDecisions)
          .set({ rulesClaimedAt: new Date() })
          .where(eq(routingDecisions.conversationId, id));
      }),
    ).toBe('decided');

    expect(await tagged(id)).toBe(0);
    expect(await decision(id)).toMatchObject({
      stage: 'holding',
      outcome: 'category',
      decidedAt: null,
      rulesDoneAt: null,
    });
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });
    expect(await acknowledgements(id)).toEqual([]);
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

  it('a person’s write after phase one ends nothing: the decision is the router’s to finish', async () => {
    errorsExpected = true;
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);

    const ended = await db.transaction(async (tx) => {
      await tx.update(conversations).set({ assigneeAgentId: lead }).where(eq(conversations.id, id));
      return endHold(tx, id, 'manual', { agentId: lead });
    });

    // The person's assignment stands. The decision, its record and the hold
    // are left as phase one wrote them, for the router to finish.
    expect(ended).toBe(false);
    expect(await decision(id)).toMatchObject({
      stage: 'holding',
      outcome: 'category',
      decidedByLabel: 'jev:category',
      decidedByAgentId: null,
      decidedAt: null,
    });
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: lead, routingDecidedAt: null });
    expect(await events(id, 'routed')).toHaveLength(1);

    // Its phase three failed, so the window's job finishes it once the minute
    // is up, and leaves the person's assignment where it is.
    await db
      .update(routingDecisions)
      .set({ phaseOneAt: new Date(Date.now() - 2 * MINUTE) })
      .where(eq(routingDecisions.conversationId, id));
    expect(await settleRouting(id)).toBe('decided');
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'jev:category' });
    expect((await ticketRow(id)).assigneeAgentId).toBe(lead);
  });

  // A person writing in the moment after phase one commits and before the
  // router claims the rules' pass. Their write stands and ends nothing
  // (`endHold`), so everything phase one owed is still the router's to pay:
  // the pass the category's writer gave up to it, the policy's second look,
  // and the hold's end.
  it('a person assigning it before the router claims its rules leaves them, and the policy, to the router', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const round = { firstResponseMins: 30, nextResponseMins: 30, resolutionMins: 240 };
    const [salesPolicy] = await db
      .insert(slaPolicies)
      .values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: { low: round, medium: round, high: round, urgent: round },
        conditions: inCategory(sales),
      })
      .returning({ id: slaPolicies.id });
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // The lib half of the console's assignee case: it ends nothing, so it
    // owes no `afterHoldEnded`, and it hands its pass to the router's
    // (`deferToRouter`), which is the one owed for the category too.
    expect(
      await routeBetweenPhases(id, async () => {
        const written = await db.transaction(async (tx) => {
          await tx
            .update(conversations)
            .set({ assigneeAgentId: lead })
            .where(eq(conversations.id, id));
          return {
            ended: await endHold(tx, id, 'manual', { agentId: lead }),
            deferred: await deferToRouter(tx, id),
          };
        });
        expect(written).toEqual({ ended: false, deferred: true });
      }),
    ).toBe('decided');

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: lead,
      slaPolicyId: salesPolicy!.id,
    });
    const row = await expectDecided(id, 'category');
    expect(row).toMatchObject({ decidedByLabel: 'jev:category', decidedByAgentId: null });
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
  });

  it('an agent’s reply before the router claims its rules leaves them, and the assignment, to the router', async () => {
    // The reply runs no update pass of its own, so the router's is the only
    // one the category is given; and it ends no hold, so nobody is assigned
    // until that pass has sent the ticket where it goes. Ended by the reply,
    // the hold let the rota give the ticket to Samir in Sales, and the rule
    // then moved it to Merchant Care with Samir still holding it.
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule(
      'on_update',
      'Tag sales',
      inCategory(sales),
      [{ type: 'add_tags', tags: ['sales'] }],
      0,
    );
    await rule(
      'on_update',
      'Merchant sales to Merchant Care',
      inCategory(sales),
      [{ type: 'assign_group', groupId: t.care.group }],
      1,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(
      await routeBetweenPhases(id, async () => {
        await storeAgentReply(id, 'email', {
          authorAgentId: t.home.agent,
          bodyText: 'Looking into it now.',
          bodyHtml: '<p>Looking into it now.</p>',
        });
        // Stored, and nothing else: still held, and still the router's.
        expect(await decision(id)).toMatchObject({
          stage: 'holding',
          outcome: 'category',
          rulesClaimedAt: null,
        });
        expect(await ticketRow(id)).toMatchObject({
          assigneeAgentId: null,
          routingDecidedAt: null,
        });
      }),
    ).toBe('decided');

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await timeline(id)).toEqual(['routed', 'tagged', 'group_changed', 'assigned']);
    expect(await expectDecided(id, 'category')).toMatchObject({
      decidedByLabel: 'jev:category',
      decidedByAgentId: null,
    });
  });

  it('an agent’s reply during the router’s pass leaves the assignment until the pass is over', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule(
      'on_update',
      'Tag sales',
      inCategory(sales),
      [{ type: 'add_tags', tags: ['sales'] }],
      0,
    );
    await rule(
      'on_update',
      'Merchant sales to Merchant Care',
      inCategory(sales),
      [{ type: 'assign_group', groupId: t.care.group }],
      1,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Phase one's transaction, then the claim's, which reads the ticket for
    // the pass; `add_tags` opens none, so the third is the second rule's
    // move, and the agent replies just before it — the pass claimed, and one
    // rule of it run.
    let claimedAtReply: Date | null | undefined;
    beforeTransaction(3, async () => {
      claimedAtReply = (await decision(id)).rulesClaimedAt;
      await storeAgentReply(id, 'email', {
        authorAgentId: t.home.agent,
        bodyText: 'Looking into it now.',
        bodyHtml: '<p>Looking into it now.</p>',
      });
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(claimedAtReply).toBeInstanceOf(Date);
    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await timeline(id)).toEqual(['routed', 'tagged', 'group_changed', 'assigned']);
    await expectDecided(id, 'category');
  });

  it('a person moving it before the router claims its rules: the router’s one pass reads the move, before the assignment', async () => {
    // The console's group case in the moment after phase one commits. The
    // move stands and ends nothing, and hands the console's own pass to the
    // router (`deferToRouter`): the router's pass, claimed after it, reads the
    // ticket in the group the person chose, and only then does its end of the
    // hold assign — in that group. One pass, not one each: run beside the
    // router's, the console's was unordered with the router's assignment.
    const t = await teams();
    const lead = await agent('Laila');
    const billing = { agent: await agent('Bilal') };
    const billingGroup = await group('Billing', [billing.agent]);
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Count passes', always, [{ type: 'add_tags', tags: ['seen'] }]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(
      await routeBetweenPhases(id, async () => {
        expect(await consoleMoves(id, billingGroup, lead)).toEqual({
          ended: false,
          deferred: true,
        });
      }),
    ).toBe('decided');

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: billingGroup,
      assigneeAgentId: billing.agent,
    });
    expect(await timeline(id)).toEqual(['routed', 'group_changed', 'tagged', 'assigned']);
    expect(await expectDecided(id, 'category')).toMatchObject({
      decidedByLabel: 'jev:category',
      toGroupId: t.sales.group,
    });
  });

  // The console's group case once the router's pass has read the ticket and
  // before its phase three: the pass ran on Sales, and the person's move to
  // Billing is one no pass has seen. Run by the console after it, beside the
  // router, its pass ran after the router had handed the ticket to Bilal in
  // Billing, and its rule then moved the ticket on to Merchant Care with Bilal
  // still holding it. Re-armed, the router runs it again on Billing before its
  // end of the hold, and the rota answers for Merchant Care.
  it('a person moving it during the router’s pass: the pass runs again on the move, before the assignment', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const billing = { agent: await agent('Bilal') };
    const billingGroup = await group('Billing', [billing.agent]);
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Count passes', always, [{ type: 'add_tags', tags: ['seen'] }], 0);
    await rule(
      'on_update',
      'Billing to Merchant Care',
      { field: 'group.id', op: 'eq', value: billingGroup },
      [{ type: 'assign_group', groupId: t.care.group }],
      1,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Phase one, the claim that reads the ticket for the pass — on Sales, so
    // neither rule opens a transaction — and then phase three, which the move
    // lands just before.
    let moved: unknown;
    beforeTransaction(3, async () => {
      moved = await consoleMoves(id, billingGroup, lead);
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(moved).toEqual({ ended: false, deferred: true });
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    // A pass for the decision and one for the move, each before anybody was
    // assigned, and the second the one that saw Billing.
    expect(await timeline(id)).toEqual([
      'routed',
      'tagged',
      'group_changed',
      'tagged',
      'group_changed',
      'assigned',
    ]);
    const row = await expectDecided(id, 'category');
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
  });

  it('a person’s category edit after phase one re-arms the router’s pass, which runs its rules once', async () => {
    // The console's category case, its lib half, in the moment after Jev's
    // phase one commits: the edit finds the decision in flight and hands its
    // pass to the router (`deferToRouter`), whose pass, claimed after it,
    // reads the category the person chose. The router once gave its pass up
    // on finding the category changed and left it to the edit, whose pass
    // then ran unordered with the router's assignment; and a pass claimed on
    // one category that read the ticket a moment later ran the person's rules
    // as well as the edit's own.
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const support = await routeTo('customer_support', null);
    await rule(
      'on_update',
      'Tag sales',
      inCategory(sales),
      [{ type: 'add_tags', tags: ['sales'] }],
      0,
    );
    await rule(
      'on_update',
      'Tag customer support',
      inCategory(support),
      [{ type: 'add_tags', tags: ['support'] }],
      1,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(
      await routeBetweenPhases(id, async () => {
        expect(await consoleFiles(id, support, lead)).toBe(true);
        expect((await decision(id)).categoryId).toBe(sales);
      }),
    ).toBe('decided');

    // The category the ticket carries, once; the one it no longer does, never.
    expect(await tagged(id)).toBe(1);
    expect(await tags(id)).toEqual(['support']);
    // Where phase one sent it, and assigned there once the pass was over.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
      categoryId: support,
    });
    expect(await timeline(id)).toEqual(['routed', 'tagged', 'assigned']);
    const row = await expectDecided(id, 'category');
    expect(row).toMatchObject({ categoryId: sales, decidedByLabel: 'jev:category' });
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
  });

  // The same edit with a rule keyed on the person's category that moves the
  // ticket on. Given the pass up, the router ended the hold and handed the
  // ticket to Samir in Sales; the edit's own pass then moved it to Merchant
  // Care, and `assign_group` left Samir holding it.
  it('a person’s category edit after phase one: its rules move the ticket before anybody is assigned', async () => {
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const support = await routeTo('customer_support', null);
    await rule('on_update', 'Support to Merchant Care', inCategory(support), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    expect(
      await routeBetweenPhases(id, async () => {
        expect(await consoleFiles(id, support, lead)).toBe(true);
      }),
    ).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await timeline(id)).toEqual(['routed', 'group_changed', 'assigned']);
  });

  it('a person’s category edit during the router’s pass: the pass runs again on it, before the assignment', async () => {
    // The edit lands once the claim has read the ticket — on Sales — and
    // before phase three: the router's pass did not see it, and its rules are
    // owed. Phase three finds the pass re-armed and runs it again, on the
    // person's category, before it ends the hold.
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const support = await routeTo('customer_support', null);
    await rule('on_update', 'Count passes', always, [{ type: 'add_tags', tags: ['seen'] }], 0);
    await rule(
      'on_update',
      'Support to Merchant Care',
      inCategory(support),
      [{ type: 'assign_group', groupId: t.care.group }],
      1,
    );
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    let deferred: boolean | undefined;
    beforeTransaction(3, async () => {
      deferred = await consoleFiles(id, support, lead);
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(deferred).toBe(true);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await timeline(id)).toEqual(['routed', 'tagged', 'tagged', 'group_changed', 'assigned']);
    // The person's rule once, though two passes ran.
    expect(await events(id, 'group_changed')).toHaveLength(1);
  });

  // Writers landing faster than a pass runs — every pass re-armed before its
  // phase three — would keep the ticket held for as long as they kept at it.
  // A trigger stands in for them, clearing the claim each time a pass is
  // marked done. After `MAX_PASSES` the hold ends all the same, and says so.
  it('ends the hold after five passes, however often they are re-armed', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Count passes', always, [{ type: 'add_tags', tags: ['seen'] }]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    await db.execute(sql`
      create function rearm_every_pass() returns trigger language plpgsql as $$
      begin
        new.rules_claimed_at := null;
        new.rules_done_at := null;
        return new;
      end $$`);
    await db.execute(sql`
      create trigger rearm_every_pass before update on routing_decisions
      for each row when (new.stage <> 'decided' and new.rules_done_at is not null)
      execute function rearm_every_pass()`);
    try {
      expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');
    } finally {
      await db.execute(sql`drop trigger rearm_every_pass on routing_decisions`);
      await db.execute(sql`drop function rearm_every_pass()`);
    }

    expect(await tagged(id)).toBe(5);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    const row = await expectDecided(id, 'category');
    // Given up, as a pass nobody may run is: claimed and over.
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
    expect(warnings.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringContaining('re-armed again after 5 passes'),
    );
  });
});

/**
 * The console's group case, its write's lib half: the move, its line stamped
 * as the console stamps it, `endHold`, and `deferToRouter`.
 */
async function consoleMoves(id: string, groupId: string, agentId: string) {
  return db.transaction(async (tx) => {
    await tx.update(conversations).set({ groupId }).where(eq(conversations.id, id));
    await tx.insert(conversationEvents).values({
      conversationId: id,
      type: 'group_changed',
      actorAgentId: agentId,
      createdAt: CHANGE_STAMP,
      data: { to: groupId },
    });
    return {
      ended: await endHold(tx, id, 'manual', { agentId }),
      deferred: await deferToRouter(tx, id),
    };
  });
}

/**
 * The console's category case, its write's lib half: the category and its
 * event, and `deferToRouter` under the lock the write holds. Answers whether
 * the edit handed its pass to the router.
 */
async function consoleFiles(id: string, categoryId: string, agentId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    expect((await setConversationCategoryOn(tx, id, categoryId, { agentId })).outcome).toBe(
      'changed',
    );
    return deferToRouter(tx, id);
  });
}

/**
 * Runs `meanwhile` just before the `nth` transaction opened from now begins —
 * how a writer is put between two of the router's steps — and lets every
 * transaction, its own included, through as it is.
 */
function beforeTransaction(nth: number, meanwhile: () => Promise<void>): void {
  const transaction = PgDatabase.prototype.transaction;
  let opened = 0;
  const spy = vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementation(function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    opened += 1;
    if (opened < nth) return transaction.call(this, run, config) as never;
    spy.mockRestore();
    return meanwhile().then(() => transaction.call(this, run, config)) as never;
  });
}

/**
 * Route the ticket, and lose the transaction that ends the hold: phase one
 * commits, the rules' pass is claimed, run and marked done, and phase three
 * fails (`refusingTheHoldsEnd`).
 */
async function interruptedAfterPhaseOne(id: string): Promise<void> {
  await refusingTheHoldsEnd(async () => {
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');
  });
  expect(await decision(id)).toMatchObject({ stage: 'holding' });
}

/**
 * Runs `meanwhile` with the end of every hold refused — `routing_decided_at`
 * set, the one write only phase three makes on its way — so whatever ends a
 * hold fails as a lost connection would, however many transactions the pass
 * before it opened.
 */
async function refusingTheHoldsEnd(meanwhile: () => Promise<void>): Promise<void> {
  await db.execute(sql`
    create function refuse_hold_end() returns trigger language plpgsql
    as $$ begin raise exception 'the connection was lost'; end $$`);
  await db.execute(sql`
    create trigger refuse_hold_end before update on conversations
    for each row when (old.routing_decided_at is null and new.routing_decided_at is not null)
    execute function refuse_hold_end()`);
  try {
    await meanwhile();
  } finally {
    await db.execute(sql`drop trigger refuse_hold_end on conversations`);
    await db.execute(sql`drop function refuse_hold_end()`);
  }
}

/**
 * Route the ticket as Jev's answer does, and run `meanwhile` the moment phase
 * one commits — the decision written, the rules' pass not yet claimed — which
 * is where another caller's claim, or a person deciding at the same time,
 * lands. Transactions opened inside `meanwhile` run as they always do.
 */
async function routeBetweenPhases(
  id: string,
  meanwhile: () => Promise<void>,
): Promise<RouteResult> {
  const transaction = PgDatabase.prototype.transaction;
  vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    const result: unknown = await transaction.call(this, run, config);
    await meanwhile();
    return result as never;
  });
  return routeNow(id, { label: 'jev:category' });
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
