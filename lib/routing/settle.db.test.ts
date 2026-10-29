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
  jobs,
  messages,
  routingDecisions,
  slaPolicies,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { setConversationCategory, setConversationCategoryOn } from '@/lib/categories/write';
import { classifyMessageCategory } from '@/lib/category-ai/run';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { resetEnvCache } from '@/lib/env';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { applySlaOnCreate } from '@/lib/sla';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { settleRoutingJob } from '@/worker/handlers/settle-routing';
import { PHASE_ONE_RESUME_MS, RULES_RUNNING_MS, routeNow, settleRouting } from './apply';
import { beginRouting } from './begin';
import { endHold } from './end-hold';
import { routingWindowValues, startRouting } from './start';
import { deferToRouter } from './state';

/**
 * The end of a routing window, and the decisions it completes, against
 * Postgres (`plans/ticket-category-routing.md`, decision 5): `settle_routing`
 * deciding whatever is there, recovering a decision whose caller died between
 * its phases, the SLA policy a decision leaves, and a shadow row, which holds
 * nothing and only records. `apply.db.test.ts` has the decision's phases and
 * what ends a hold early; `begin.db.test.ts` the insert and the creation pass.
 *
 * Built as `apply.db.test.ts` builds its tickets — from rows, the window on the
 * insert, started through `startRouting` and begun through `beginRouting`, on
 * the real clock — and with
 * its rule that an error logged is a test failed unless the test asked for it.
 */

withCleanDatabase();

const MINUTE = 60_000;

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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A person's write in the gap, as the console's category and group cases make
 * one: the write, and `deferToRouter` under the lock it holds — which re-arms
 * the router's pass, and answers whether it did.
 */
async function rearmedBy(write: (tx: Tx) => Promise<void>, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await write(tx);
    return deferToRouter(tx, id);
  });
}

/**
 * Phase one written and nothing after it: the caller died between phase one's
 * commit and its claim on the rules' pass. Built as an interrupted decision
 * and wound back to before the claim, which is the row such a caller leaves.
 */
async function diedAfterPhaseOne(id: string): Promise<void> {
  await interruptedAfterPhaseOne(id);
  await db
    .update(routingDecisions)
    .set({ rulesClaimedAt: null, rulesDoneAt: null })
    .where(eq(routingDecisions.conversationId, id));
}

/** The rules' pass claimed `ago`, by a caller that has not marked it done. */
async function rulesClaimed(id: string, ago: number): Promise<Date> {
  const rulesClaimedAt = new Date(Date.now() - ago);
  await db
    .update(routingDecisions)
    .set({ rulesClaimedAt, rulesDoneAt: null })
    .where(eq(routingDecisions.conversationId, id));
  return rulesClaimedAt;
}

/**
 * The next transaction runs, and the moment it commits another caller claims
 * the rules' pass: what a caller whose claim is lost meets, put exactly
 * between its phase one and its own claim.
 */
function claimedByAnotherAfterNextTransaction(id: string): void {
  const transaction = PgDatabase.prototype.transaction;
  vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    const result: unknown = await transaction.call(this, run, config);
    await db
      .update(routingDecisions)
      .set({ rulesClaimedAt: new Date() })
      .where(eq(routingDecisions.conversationId, id));
    return result as never;
  });
}

/** How many times a rule's `add_tags` has run on the ticket: one event each. */
async function tagged(id: string): Promise<number> {
  return (await events(id, 'tagged')).length;
}

/** The `settle_routing` jobs for a ticket, oldest first. */
async function settleJobs(id: string) {
  return db
    .select({
      payload: jobs.payload,
      runAt: jobs.runAt,
      priority: jobs.priority,
      dedupeKey: jobs.dedupeKey,
      status: jobs.status,
    })
    .from(jobs)
    .where(and(eq(jobs.type, 'settle_routing'), sql`${jobs.payload}->>'conversationId' = ${id}`))
    .orderBy(asc(jobs.createdAt));
}

/** A claimed `settle_routing` job, as the worker hands it to the handler. */
function claimed(conversationId: string): ClaimedJob {
  return {
    id: 'job-1',
    type: 'settle_routing',
    payload: { conversationId },
  } as unknown as ClaimedJob;
}

// --- The window's end -------------------------------------------------------

describe('settleRouting, at the window’s end', () => {
  it('decides fallback with nothing settled, and assigns the ticket where it is', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    expect(await settleRouting(id)).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
    });
    expect(await expectDecided(id, 'fallback')).toMatchObject({
      fromGroupId: t.home.group,
      toGroupId: t.home.group,
      categoryId: null,
      probability: null,
      decidedByLabel: 'settle_routing',
    });
    expect((await events(id, 'routed'))[0]).toMatchObject({
      actorLabel: 'routing',
      data: { outcome: 'fallback', by: 'settle_routing', moved: false },
    });
  });

  it('decides a ticket the creation pass never began, as though it were holding', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    expect(await settleRouting(id)).toBe('decided');

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
    await expectDecided(id, 'fallback');
  });

  it('routes on a category a rule set during the hold, which could not route it then', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Pricing questions are sales', always, [
      { type: 'set_category', categoryId: sales },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);

    // A rule's `set_category` settles the category without stamping: actions
    // never re-enter the engine, so nothing routes until the window's end.
    await afterTicketUpdate(id);
    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.home.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null });

    expect(await settleRouting(id)).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({
      categoryId: sales,
      decidedByLabel: 'settle_routing',
    });
  });

  it('records taken for a ticket somebody holds without a stamp, and never moves it', async () => {
    // The sweep after the grace, or a stuck worker: an assignment that did not
    // go through `endHold`.
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await db
      .update(conversations)
      .set({ assigneeAgentId: t.home.agent })
      .where(eq(conversations.id, id));
    await jevFiles(id, sales);

    expect(await settleRouting(id)).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
    });
    expect(await expectDecided(id, 'taken')).toMatchObject({ toGroupId: t.home.group });
  });

  it('records not_open for a merged ticket, and assigns nothing', async () => {
    const t = await teams();
    const survivor = await heldTicket(t.channel, t.home.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await db
      .update(conversations)
      .set({ mergedIntoId: survivor.id })
      .where(eq(conversations.id, id));

    expect(await settleRouting(id)).toBe('none');

    expect((await ticketRow(id)).assigneeAgentId).toBeNull();
    await expectDecided(id, 'not_open');
  });

  it('does nothing on a decided ticket: no event, no job, no assignment', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);
    expect(await settleRouting(id)).toBe('decided');
    const before = { row: await decision(id), ticket: await ticketRow(id) };

    expect(await settleRouting(id)).toBe('none');

    expect(await decision(id)).toEqual(before.row);
    expect(await ticketRow(id)).toEqual(before.ticket);
    await expectDecided(id, 'fallback');
    expect(await settleJobs(id)).toHaveLength(1);
  });

  it('leaves a late answer from Jev to relabel the ticket where the window left it', async () => {
    // Jev's retries back off 10, 40, 90 and 160 seconds; an answer after the
    // window's end finds the ticket decided.
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    resetEnvCache();
    stubFetch(() =>
      Response.json({
        model: 'jev-1.13.0',
        answers: {
          ticket_category: {
            type: 'choice',
            choice: 'sales',
            probabilities: { sales: 0.9, customer_support: 0.05 },
            confidence: 0.8,
          },
        },
      }),
    );
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id, messageId } = await heldTicket(t.channel, t.home.group);
    expect(await settleRouting(id)).toBe('decided');

    expect(
      await classifyMessageCategory(messageId, { baseUrl: 'https://typesafe.test' }),
    ).toMatchObject({ outcome: 'applied' });

    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
    });
    // Relabelled: the update pass ran, as after any category write.
    const [row] = await db
      .select({ tags: conversations.tags })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.tags).toEqual(['sales']);
    await expectDecided(id, 'fallback');
  });

  it('answers gone for a ticket that no longer exists, and its job ends for good', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';

    expect(await settleRouting(missing)).toBe('gone');
    await expect(settleRoutingJob(claimed(missing))).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('is what the job runs', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group);

    await settleRoutingJob(claimed(id));

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
    await expectDecided(id, 'fallback');
  });
});

// --- Recovery ---------------------------------------------------------------

/**
 * Move an interrupted decision's phase one `ago` into the past, which is when
 * the caller that wrote it died — so the window's end can be run on the real
 * clock, on which the roster's heartbeats are fresh.
 */
async function phaseOneWritten(id: string, ago: number): Promise<Date> {
  const phaseOneAt = new Date(Date.now() - ago);
  await db
    .update(routingDecisions)
    .set({ phaseOneAt })
    .where(eq(routingDecisions.conversationId, id));
  return phaseOneAt;
}

describe('a decision interrupted between its phases', () => {
  it('is completed by settle_routing once its phase one is a minute old', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await diedAfterPhaseOne(id);
    const phaseOneAt = await phaseOneWritten(id, 2 * MINUTE);
    // What phase two owes is run from what phase one wrote: the rules keyed on
    // the category, before anybody is assigned.
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);

    expect(await settleRouting(id)).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    // Phase one's decision and its one event stand; the completion adds neither.
    const row = await expectDecided(id, 'category');
    expect(row).toMatchObject({
      toGroupId: t.sales.group,
      decidedByLabel: 'jev:category',
      phaseOneAt,
    });
    // Nobody had claimed the pass, so the completion claimed it and ran it.
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
  });

  it('runs the rules once, though its phase three fails and the job is retried', async () => {
    // Every retry of a failed phase three used to re-run the whole pass: a
    // category's `send_reply` reached the customer once per attempt.
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Phase one commits, the rules run, and the transaction ending the hold
    // does not.
    await refusingTheHoldsEnd(async () => {
      await expect(settleRoutingJob(claimed(id))).rejects.toThrow('did not end');
    });
    expect(await tagged(id)).toBe(1);
    expect(await decision(id)).toMatchObject({ stage: 'holding' });
    expect((await decision(id)).rulesDoneAt).toBeInstanceOf(Date);

    await phaseOneWritten(id, 2 * MINUTE);
    await settleRoutingJob(claimed(id));

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    await expectDecided(id, 'category');
  });

  it('leaves a pass claimed less than RULES_RUNNING_MS ago to its claimant, and looks again then', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await diedAfterPhaseOne(id);
    await phaseOneWritten(id, 2 * MINUTE);
    const claimedAt = await rulesClaimed(id, MINUTE);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);

    expect(await settleRouting(id)).toBe('requeued');

    // Nothing run and nothing ended: the claimant owns phase two and three.
    expect(await tagged(id)).toBe(0);
    expect(await decision(id)).toMatchObject({ stage: 'holding', decidedAt: null });
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    expect((await settleJobs(id))[1]).toMatchObject({
      dedupeKey: null,
      priority: 40,
      status: 'pending',
      runAt: new Date(claimedAt.getTime() + RULES_RUNNING_MS + 1_000),
    });

    // Exactly until the claim is that old.
    expect(await settleRouting(id, new Date(claimedAt.getTime() + RULES_RUNNING_MS - 1))).toBe(
      'requeued',
    );
    expect(await tagged(id)).toBe(0);
  });

  it('ends the hold without the rules once a claim has aged, for a claimant that died part-way', async () => {
    // At most once: which of its rules the claimant ran is written nowhere,
    // and a pass half-applied once does less harm than one applied twice.
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await diedAfterPhaseOne(id);
    await phaseOneWritten(id, 15 * MINUTE);
    await rulesClaimed(id, RULES_RUNNING_MS + MINUTE);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);

    expect(await settleRouting(id)).toBe('decided');

    expect(await tagged(id)).toBe(0);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    await expectDecided(id, 'category');
    expect(warnings.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringContaining("without the rules' pass, claimed and never finished"),
    );
  });

  it('looks again, and ends nothing, when its own claim on the rules is lost', async () => {
    // The claimant may be a caller that stalled past the minute after its
    // phase one, and this the window's own job: nothing else would come for
    // the ticket if the claimant then died.
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await diedAfterPhaseOne(id);
    await phaseOneWritten(id, 2 * MINUTE);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);

    claimedByAnotherAfterNextTransaction(id);
    const before = Date.now();
    expect(await settleRouting(id)).toBe('requeued');

    expect(await tagged(id)).toBe(0);
    expect(await decision(id)).toMatchObject({ stage: 'holding', decidedAt: null });
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    const again = (await settleJobs(id))[1]!;
    expect(again).toMatchObject({ dedupeKey: null, status: 'pending' });
    expect(again.runAt.getTime()).toBeGreaterThanOrEqual(before + RULES_RUNNING_MS);
  });

  it('is left to a caller still running it, and looked at again — without a key', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);
    const phaseOneAt = await phaseOneWritten(id, 30_000);

    expect(await settleRouting(id)).toBe('requeued');

    // Untouched: still held, nobody assigned.
    expect(await decision(id)).toMatchObject({ stage: 'holding', decidedAt: null });
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    // The first job's key is spent for good, so the second carries none.
    const [first, second] = await settleJobs(id);
    expect(first).toMatchObject({ dedupeKey: `settle_routing:${id}` });
    expect(second).toMatchObject({
      payload: { conversationId: id },
      dedupeKey: null,
      priority: 40,
      status: 'pending',
      runAt: new Date(phaseOneAt.getTime() + PHASE_ONE_RESUME_MS + 1_000),
    });
  });

  it('holds exactly until the minute is up', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);
    const { phaseOneAt } = await decision(id);

    expect(await settleRouting(id, new Date(phaseOneAt!.getTime() + PHASE_ONE_RESUME_MS - 1))).toBe(
      'requeued',
    );
    expect(await settleRouting(id, new Date(phaseOneAt!.getTime() + PHASE_ONE_RESUME_MS))).toBe(
      'decided',
    );
    await expectDecided(id, 'category');
  });

  it('throws when its own phase three fails, so its retry completes the decision', async () => {
    // The window's job is the one caller nothing comes after: its key is
    // spent once it completes, so a phase three it swallowed left the ticket
    // held, unassigned and unanswered for good.
    errorsExpected = true;
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
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
    const { id } = await heldTicket(t.channel, t.home.group);
    await applySlaOnCreate(id);
    await jevFiles(id, sales);

    // Phase one commits; the transaction that ends the hold does not. No
    // rules, so phase two opens none in between.
    const transaction = PgDatabase.prototype.transaction;
    const spy = vi
      .spyOn(PgDatabase.prototype, 'transaction')
      .mockImplementationOnce(function (this: PgDatabase<never>, run, config) {
        return transaction.call(this, run, config) as never;
      })
      .mockImplementationOnce(() => Promise.reject(new Error('the connection was lost')));
    const failure = await settleRoutingJob(claimed(id)).then(
      () => null,
      (error: unknown) => error,
    );
    spy.mockRestore();

    // Retried, not dead: the decision is written, and only its end failed.
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: 'category' });
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });
    expect(await acknowledgements(id)).toEqual([]);

    // The queue's first retry comes within the minute, which still belongs
    // to the run that wrote phase one: it looks again, without a key.
    await settleRoutingJob(claimed(id));
    expect(await settleJobs(id)).toEqual([
      expect.objectContaining({ dedupeKey: `settle_routing:${id}` }),
      expect.objectContaining({ dedupeKey: null, status: 'pending' }),
    ]);

    // And once the minute is up, the decision is completed: the hold ended,
    // the ticket assigned in its route group, the SLA chosen again for the
    // category, and the held reply sent.
    await phaseOneWritten(id, 2 * MINUTE);
    await settleRoutingJob(claimed(id));

    await expectDecided(id, 'category');
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
      slaPolicyId: salesPolicy!.id,
    });
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ cause: 'category', policyId: salesPolicy!.id }),
    ]);
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  // The ticket may have changed since the decision was written, and what was
  // owed is owed only on a ticket somebody may still work — the answer a
  // fresh decision would have recorded as `not_open`.
  it.each<[string, (id: string, survivor: string) => Promise<void>]>([
    [
      'resolved',
      async (id) => {
        await db
          .update(conversations)
          .set({ statusId: await status('Resolved') })
          .where(eq(conversations.id, id));
      },
    ],
    [
      'deleted',
      async (id) => {
        await db
          .update(conversations)
          .set({ deletedAt: new Date() })
          .where(eq(conversations.id, id));
      },
    ],
    [
      'marked spam',
      async (id) => {
        await db.update(conversations).set({ isSpam: true }).where(eq(conversations.id, id));
      },
    ],
    [
      'merged',
      async (id, survivor) => {
        await db
          .update(conversations)
          .set({ mergedIntoId: survivor })
          .where(eq(conversations.id, id));
      },
    ],
  ])('on a ticket %s since, ends the hold and owes nothing', async (_label, since) => {
    errorsExpected = true;
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const survivor = await heldTicket(t.channel, t.home.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);
    await phaseOneWritten(id, 2 * MINUTE);
    await rule('on_update', 'Tag everything', always, [{ type: 'add_tags', tags: ['ran'] }]);
    await since(id, survivor.id);

    const result = await settleRouting(id);

    // No rule ran on it, nobody was given it, and nothing was said.
    const [row] = await db
      .select({ tags: conversations.tags, assigneeAgentId: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row).toEqual({ tags: [], assigneeAgentId: null });
    expect(await acknowledgements(id)).toEqual([]);
    // Phase one's decision stands, and the hold is over.
    await expectDecided(id, 'category');
    expect(result).toBe('none');
  });

  it('gives the pass up with the decision, so a caller that only stalled runs nothing when it wakes', async () => {
    // The minute that makes a caller "gone" is silence, not proof. The window's
    // job finishes this decision without the rules on a ticket resolved since;
    // the caller that wrote phase one then wakes and asks the claim alone
    // whether its pass is still to run, so the job's answer has to be in the
    // claim.
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag everything', always, [{ type: 'add_tags', tags: ['ran'] }]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    // Between the caller's phase one and its claim: the ticket resolved, and
    // the window's job a minute on.
    const transaction = PgDatabase.prototype.transaction;
    vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
      this: PgDatabase<never>,
      run,
      config,
    ) {
      const result: unknown = await transaction.call(this, run, config);
      await db
        .update(conversations)
        .set({ statusId: await status('Resolved') })
        .where(eq(conversations.id, id));
      expect(await settleRouting(id, new Date(Date.now() + PHASE_ONE_RESUME_MS))).toBe('none');
      return result as never;
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    // No rule ran on it, nobody was given it, and nothing was said.
    const [row] = await db
      .select({ tags: conversations.tags, assigneeAgentId: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row).toEqual({ tags: [], assigneeAgentId: null });
    expect(await acknowledgements(id)).toEqual([]);
    // The pass given up, never run: claimed with the decision, and not done.
    const decided = await expectDecided(id, 'category');
    expect(decided.rulesClaimedAt).toBeInstanceOf(Date);
    expect(decided.rulesDoneAt).toBeNull();
  });

  // An agent's reply in the gap ends nothing and decides nothing (`endHold`),
  // so the window's job resumes the decision as it would for any caller that
  // stalled, finds the ticket resolved, and gives the pass up; the caller,
  // waking, finds the pass claimed. Decided by the reply instead, the row was
  // one the job never resumes, and the woken caller ran its rules on the
  // resolved ticket.
  it('runs nothing on a ticket resolved since, though an agent answered it in between', async () => {
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag everything', always, [{ type: 'add_tags', tags: ['ran'] }]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    const transaction = PgDatabase.prototype.transaction;
    vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
      this: PgDatabase<never>,
      run,
      config,
    ) {
      const result: unknown = await transaction.call(this, run, config);
      await storeAgentReply(id, 'email', {
        authorAgentId: t.home.agent,
        bodyText: 'Sorted, closing this.',
        bodyHtml: '<p>Sorted, closing this.</p>',
      });
      await db
        .update(conversations)
        .set({ statusId: await status('Resolved'), resolvedAt: new Date() })
        .where(eq(conversations.id, id));
      expect(await settleRouting(id, new Date(Date.now() + 2 * MINUTE))).toBe('none');
      return result as never;
    });
    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    const [row] = await db
      .select({ tags: conversations.tags, assigneeAgentId: conversations.assigneeAgentId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row).toEqual({ tags: [], assigneeAgentId: null });
    expect(await acknowledgements(id)).toEqual([]);
    // The router's decision, ended by the window's job with the pass given up.
    const decided = await expectDecided(id, 'category');
    expect(decided).toMatchObject({ decidedByLabel: 'jev:category', decidedByAgentId: null });
    expect(decided.rulesClaimedAt).toBeInstanceOf(Date);
    expect(decided.rulesDoneAt).toBeNull();
  });

  // The router's claim on its pass fails — a connection lost, a deploy's
  // shutdown — after an agent answered in the gap. The reply took nothing
  // over (`endHold`), so the row is still undecided with its pass unclaimed,
  // and the window's job completes both once phase one is a minute old.
  // Decided by the reply, the row was one the job never resumes: the
  // category's rules and the policy's second look were lost for good.
  it('completes the pass a failed claim left owed, though an agent answered in between', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Merchant sales to Merchant Care', inCategory(sales), [
      { type: 'assign_group', groupId: t.care.group },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);

    await db.execute(sql`
      create function refuse_claim() returns trigger language plpgsql
      as $$ begin raise exception 'the connection was lost'; end $$`);
    let result: Awaited<ReturnType<typeof routeNow>> | undefined;
    try {
      const transaction = PgDatabase.prototype.transaction;
      vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementationOnce(async function (
        this: PgDatabase<never>,
        run,
        config,
      ) {
        const written: unknown = await transaction.call(this, run, config);
        await storeAgentReply(id, 'email', {
          authorAgentId: t.home.agent,
          bodyText: 'Looking into it now.',
          bodyHtml: '<p>Looking into it now.</p>',
        });
        await db.execute(sql`
          create trigger refuse_claim before update on routing_decisions
          for each row when (old.rules_claimed_at is null and new.rules_claimed_at is not null)
          execute function refuse_claim()`);
        return written as never;
      });
      result = await routeNow(id, { label: 'jev:category' });
    } finally {
      await db.execute(sql`drop trigger if exists refuse_claim on routing_decisions`);
      await db.execute(sql`drop function refuse_claim()`);
    }
    expect(result).toBe('failed');
    expect(await decision(id)).toMatchObject({
      stage: 'holding',
      outcome: 'category',
      rulesClaimedAt: null,
    });
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });

    await phaseOneWritten(id, 2 * MINUTE);
    expect(await settleRouting(id)).toBe('decided');

    // The rule ran, before anybody was assigned, and the ticket is with
    // Merchant Care's agent.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect((await events(id, 'group_changed')).map((event) => event.data.to)).toEqual([
      t.care.group,
    ]);
    const row = await expectDecided(id, 'category');
    expect(row).toMatchObject({ decidedByLabel: 'jev:category', decidedByAgentId: null });
    expect(row.rulesClaimedAt).toBeInstanceOf(Date);
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
  });

  // A claimant that died part-way leaves a pass nobody may run again, since
  // which of its rules ran is written nowhere (above). A person's write after
  // it is owed a pass of its own all the same, and has handed it to the
  // router (`deferToRouter`): the re-arm clears the claim, and the window's
  // job runs the pass on the ticket as the write left it rather than ending
  // the hold without one.
  it('runs a pass a writer re-armed, though the claim it cleared was a dead claimant’s', async () => {
    errorsExpected = true;
    const t = await teams();
    const lead = await agent('Laila');
    const sales = await routeTo('sales', t.sales.group);
    const support = await routeTo('customer_support', null);
    const { id } = await heldTicket(t.channel, t.home.group);
    await jevFiles(id, sales);
    await diedAfterPhaseOne(id);
    await phaseOneWritten(id, 15 * MINUTE);
    await rulesClaimed(id, RULES_RUNNING_MS + MINUTE);
    await rule('on_update', 'Tag customer support', inCategory(support), [
      { type: 'add_tags', tags: ['support'] },
    ]);

    expect(
      await rearmedBy(async (tx) => {
        await setConversationCategoryOn(tx, id, support, { agentId: lead });
      }, id),
    ).toBe(true);
    expect(await decision(id)).toMatchObject({ rulesClaimedAt: null, rulesDoneAt: null });

    expect(await settleRouting(id)).toBe('decided');

    expect(await tagged(id)).toBe(1);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    const row = await expectDecided(id, 'category');
    expect(row.rulesDoneAt).toBeInstanceOf(Date);
    expect(warnings.mock.calls.map((call) => String(call[0]))).not.toContainEqual(
      expect.stringContaining("without the rules' pass"),
    );
  });

  // The router ran its pass, and its phase three failed. A person moving the
  // ticket in the gap after that hands their pass to the router, which has
  // gone: the window's job finds the pass re-armed, not done, and runs it on
  // the ticket in the group the person chose — before it assigns anybody.
  it('runs a pass a writer re-armed after the router’s phase three failed, before assigning', async () => {
    errorsExpected = true;
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
    await interruptedAfterPhaseOne(id);
    expect(await tagged(id)).toBe(1);
    expect((await decision(id)).rulesDoneAt).toBeInstanceOf(Date);

    expect(
      await rearmedBy(async (tx) => {
        await tx
          .update(conversations)
          .set({ groupId: billingGroup })
          .where(eq(conversations.id, id));
        expect(await endHold(tx, id, 'manual', { agentId: lead })).toBe(false);
      }, id),
    ).toBe(true);

    await phaseOneWritten(id, 2 * MINUTE);
    expect(await settleRouting(id)).toBe('decided');

    // The pass the decision owed, and the one the move did.
    expect(await tagged(id)).toBe(2);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    await expectDecided(id, 'category');
  });

  it('keeps the creation pass from assigning a ticket the router has taken', async () => {
    errorsExpected = true;
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });
    await jevFiles(id, sales);
    await interruptedAfterPhaseOne(id);

    // The creation pass reaching `beginRouting` now finds the decision in
    // flight, and leaves the assignment to whoever is finishing it.
    expect(await beginRouting(id)).toBe('routed');
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
  });
});

// --- The SLA ------------------------------------------------------------------

describe('the SLA policy, after a routed move', () => {
  /** Round the clock, so a target is a fixed number of wall-clock minutes. */
  const target = (firstResponseMins: number, resolutionMins: number) => {
    const row = { firstResponseMins, nextResponseMins: firstResponseMins, resolutionMins };
    return { low: row, medium: row, high: row, urgent: row };
  };

  /** Sales' own (30/240), keyed on the category, and the default (120/480). */
  async function policies(sales: string) {
    const [salesPolicy] = await db
      .insert(slaPolicies)
      .values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: target(30, 240),
        position: 0,
        conditions: inCategory(sales),
      })
      .returning({ id: slaPolicies.id });
    const [standard] = await db
      .insert(slaPolicies)
      .values({
        name: 'Standard',
        hoursSource: 'round_the_clock',
        targets: target(120, 480),
        position: 1,
        isDefault: true,
      })
      .returning({ id: slaPolicies.id });
    return { sales: salesPolicy!.id, standard: standard!.id };
  }

  const at = (from: Date, minutes: number) => new Date(from.getTime() + minutes * MINUTE);

  it('chooses the route’s policy, counted from the ticket’s own anchor with its pauses credited', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const policy = await policies(sales);
    const createdAt = new Date(Date.now() - 120 * MINUTE);
    const { id } = await heldTicket(t.channel, t.home.group, { createdAt });
    await applySlaOnCreate(id);
    expect((await ticketRow(id)).slaPolicyId).toBe(policy.standard);
    await db.insert(conversationEvents).values([
      { conversationId: id, type: 'sla_paused', actorLabel: 'sla', createdAt: at(createdAt, 10) },
      {
        conversationId: id,
        type: 'sla_resumed',
        actorLabel: 'sla',
        createdAt: at(createdAt, 40),
        data: { pausedMinutes: 30, from: at(createdAt, 10).toISOString() },
      },
    ]);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      slaPolicyId: policy.sales,
      firstResponseDueAt: at(createdAt, 30 + 30),
      resolutionDueAt: at(createdAt, 240 + 30),
    });
    // Once, for the policy, and not again for the move it came with.
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'policy', cause: 'category', policyId: policy.sales }),
    ]);
  });

  it('leaves the policy, and says nothing, when the window ends with nothing to change', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const policy = await policies(sales);
    const { id } = await heldTicket(t.channel, t.home.group);
    await applySlaOnCreate(id);

    expect(await settleRouting(id)).toBe('decided');

    expect((await ticketRow(id)).slaPolicyId).toBe(policy.standard);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('re-times a move the policy survives on the route group’s hours', async () => {
    const t = await teams();
    await keeps(
      t.sales.group,
      await calendar('An hour on Sundays', { ...SHUT, sun: [{ start: '00:00', end: '01:00' }] }),
    );
    const [standard] = await db
      .insert(slaPolicies)
      .values({
        name: 'Standard',
        hoursSource: 'group',
        targets: target(120, 480),
        isDefault: true,
      })
      .returning({ id: slaPolicies.id });
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group);
    await applySlaOnCreate(id);
    const before = await ticketRow(id);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('decided');

    const after = await ticketRow(id);
    expect(after.slaPolicyId).toBe(standard!.id);
    expect(after.firstResponseDueAt!.getTime()).toBeGreaterThan(
      before.firstResponseDueAt!.getTime(),
    );
    expect((await events(id, 'sla_recalculated')).map((e) => e.data)).toEqual([
      expect.objectContaining({ reason: 'group_hours' }),
    ]);
  });
});

// --- Shadow -----------------------------------------------------------------

describe('a shadow row', () => {
  it('holds nothing: assignment goes ahead, and the reply too', async () => {
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const held = await heldTicket(t.channel, t.home.group, { shadow: true });

    expect((await ticketRow(held.id)).routingWindowEndsAt).toBeNull();
    expect(await assignConversation(held.id)).toMatchObject({ assignedTo: t.home.agent });
    await maybeSendAutoResponse({ conversationId: held.id, messageId: held.messageId });
    expect(await acknowledgements(held.id)).toHaveLength(1);
  });

  it('records where Jev’s answer would have sent the ticket, and moves nothing', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const sales = await routeTo('sales', t.sales.group);
    const { id } = await heldTicket(t.channel, t.home.group, { shadow: true });
    // The rota assigned on arrival, as it does when nothing is held.
    await assignConversation(id);
    await jevFiles(id, sales);

    expect(await routeNow(id, { label: 'jev:category' })).toBe('shadow');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
      routingDecidedAt: null,
    });
    // Not `taken`: the machine's assignment is what a live hold would have stopped.
    expect(await expectDecided(id, 'category')).toMatchObject({
      shadow: true,
      toGroupId: t.sales.group,
      phaseOneAt: null,
    });
    expect(await settleRouting(id)).toBe('none');
  });

  it('records fallback at the window’s end, not taken, though the rota assigned it', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const { id } = await heldTicket(t.channel, t.home.group, { shadow: true });
    await assignConversation(id);

    expect(await settleRouting(id)).toBe('shadow');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
      routingDecidedAt: null,
    });
    expect(await expectDecided(id, 'fallback')).toMatchObject({
      decidedByLabel: 'settle_routing',
      toGroupId: t.home.group,
    });
  });

  it('is released by its channel going back to the default group, and by nothing else', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group, { shadow: true });
    // A shadow ticket on a channel since moved on to live routing still wants
    // its would-be answer: only the default group releases it.
    expect(await settleRouting(id)).toBe('shadow');
    await expectDecided(id, 'fallback');

    const other = await heldTicket(t.channel, t.home.group, { shadow: true });
    await db
      .update(channels)
      .set({ routingMode: 'default_group' })
      .where(eq(channels.id, t.channel));
    expect(await settleRouting(other.id)).toBe('shadow');
    await expectDecided(other.id, 'released');
  });

  it('records a person’s move as manual, and ends no hold it never had', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const lead = await agent('Laila');
    const { id } = await heldTicket(t.channel, t.home.group, { shadow: true });

    const ended = await db.transaction(async (tx) => {
      await tx.update(conversations).set({ groupId: t.care.group }).where(eq(conversations.id, id));
      return endHold(tx, id, 'manual', { agentId: lead });
    });

    expect(ended).toBe(false);
    expect(await expectDecided(id, 'manual')).toMatchObject({
      toGroupId: t.care.group,
      decidedByAgentId: lead,
    });
  });
});
