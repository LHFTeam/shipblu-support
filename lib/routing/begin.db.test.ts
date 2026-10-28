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
import { runAutomations } from '@/lib/automations';
import { classifyMessageCategory } from '@/lib/category-ai/run';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import type { InboundDelivery, ParsedInboundEmail } from '@/lib/email/types';
import { resetEnvCache } from '@/lib/env';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { ingestInboundEmail } from '@/lib/tickets/ingest';
import { afterTicketUpdate } from '@/lib/tickets/lifecycle';
import { settleRouting } from './apply';
import { beginRouting } from './begin';
import { SETTLE_ROUTING_PRIORITY, planRouting, startRouting } from './start';

/**
 * Where routing starts, against Postgres (`plans/ticket-category-routing.md`,
 * decision 5): the hold written in the ticket's insert, and the creation pass
 * that begins it — after the `on_create` rules, so a rule gets the first word.
 * `apply.db.test.ts` has the decision itself; `settle.db.test.ts` the window's
 * end.
 *
 * Through the real email ingest wherever the insert or the creation pass is
 * the point, since that is the path that runs them in their order; from rows
 * started through `startRouting` where a test must stop between the insert
 * and `beginRouting` — the moment the race into the creation pass is about,
 * which the ingest never pauses in. TypeSafe is answered by the test.
 *
 * Every best-effort step here logs instead of throwing, so a failure inside
 * one would read as "nothing happened": a test fails on any error logged it
 * did not ask for.
 */

withCleanDatabase();

const MINUTE = 60_000;
const BASE = 'https://typesafe.test';

let errors: MockInstance;
let errorsExpected = false;

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

/** A mail as a test hands it to ingest: what the provider parsed, and when it reached us. */
function mail(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  people += 1;
  return {
    messageId: `mail${people}@customer.example`,
    references: [],
    from: { address: `amira${people}@customer.example`, name: 'Amira' },
    to: [{ address: 'support@shipblu.test' }],
    cc: [],
    subject: 'Where is my parcel?',
    textBody: 'Hello, my parcel has not arrived.',
    attachments: [],
    headers: {},
    dateHeader: null,
    ...overrides,
  };
}

/** Ingested as the webhook job ingests it, creation pass and all. */
async function ingested(
  email: ParsedInboundEmail,
  delivery: InboundDelivery = { receivedAt: new Date() },
) {
  const result = await ingestInboundEmail(email, delivery);
  if (!result) throw new Error('ingest returned null');
  return result;
}

/** The `settle_routing` jobs for a ticket, oldest first. */
async function settleJobs(id: string) {
  return db
    .select({
      payload: jobs.payload,
      runAt: jobs.runAt,
      priority: jobs.priority,
      dedupeKey: jobs.dedupeKey,
    })
    .from(jobs)
    .where(and(eq(jobs.type, 'settle_routing'), sql`${jobs.payload}->>'conversationId' = ${id}`))
    .orderBy(asc(jobs.createdAt));
}

/** TypeSafe choosing `choice`, as Jev answers the category question. */
function jevAnswers(choice: string, probability = 0.9) {
  return stubFetch(() =>
    Response.json({
      model: 'jev-1.13.0',
      answers: {
        ticket_category: {
          type: 'choice',
          choice,
          probabilities: { [choice]: probability, customer_support: 0.05 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 500 },
    }),
  );
}

/** A default policy (120/480) and, above it, one for sales (30/240), round the clock. */
async function policies(sales: string) {
  const target = (firstResponseMins: number, resolutionMins: number) => {
    const row = { firstResponseMins, nextResponseMins: firstResponseMins, resolutionMins };
    return { low: row, medium: row, high: row, urgent: row };
  };
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

// --- The insert -------------------------------------------------------------

describe('the insert', () => {
  it('holds a new mail from its insert: the window, the row and the job', async () => {
    const t = await teams();
    const before = new Date();
    // Processed two hours after it reached us, after a worker pause.
    const receivedAt = new Date(Date.now() - 120 * MINUTE);

    const result = await ingested(mail(), { receivedAt });
    const id = result.conversationId;

    const row = await decision(id);
    expect(row).toMatchObject({
      channelId: t.channel,
      shadow: false,
      // Begun by the creation pass, which found no category to route on.
      stage: 'holding',
      outcome: null,
      fromGroupId: t.home.group,
      messageId: result.messageId,
    });
    // On the processing clock, not the receipt's: the mail still gets its
    // whole window.
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    expect(row.windowEndsAt.getTime() - row.startedAt.getTime()).toBe(5 * MINUTE);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: null,
      routingWindowEndsAt: row.windowEndsAt,
      routingDecidedAt: null,
    });
    expect(await settleJobs(id)).toEqual([
      {
        payload: { conversationId: id },
        runAt: row.windowEndsAt,
        priority: SETTLE_ROUTING_PRIORITY,
        dedupeKey: `settle_routing:${id}`,
      },
    ]);
    expect(SETTLE_ROUTING_PRIORITY).toBe(40);
    // Held, and not one line on the timeline for it.
    expect(await events(id, 'assignment_skipped')).toEqual([]);
    expect(await events(id, 'routed')).toEqual([]);
  });

  it('copies the window from the classifier’s setting, and a change moves no window running', async () => {
    await teams();
    await classifier('apply', 12);

    const { conversationId: id } = await ingested(mail());
    const row = await decision(id);
    expect(row.windowEndsAt.getTime() - row.startedAt.getTime()).toBe(12 * MINUTE);

    // Copied onto the ticket at its insert, so the admin's next save starts
    // the next window and leaves this one alone.
    await classifier('apply', 1);
    expect((await ticketRow(id)).routingWindowEndsAt).toEqual(row.windowEndsAt);
    expect((await decision(id)).windowEndsAt).toEqual(row.windowEndsAt);
  });

  it.each(['off', 'shadow'] as const)(
    'starts nothing while the classifier is %s, and the rota assigns on arrival',
    async (mode) => {
      const t = await teams();
      await classifier(mode);

      const { conversationId: id } = await ingested(mail());

      expect(await db.select().from(routingDecisions)).toEqual([]);
      expect(await settleJobs(id)).toEqual([]);
      expect(await ticketRow(id)).toMatchObject({
        routingWindowEndsAt: null,
        assigneeAgentId: t.home.agent,
      });
    },
  );

  it('starts nothing on a mailbox that routes by its default group', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'default_group' })
      .where(eq(channels.id, t.channel));

    const { conversationId: id } = await ingested(mail());

    expect(await db.select().from(routingDecisions)).toEqual([]);
    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
  });

  it('starts nothing for a bounce, which is filed as spam', async () => {
    await teams();

    const { conversationId: id } = await ingested(
      mail({ from: { address: 'mailer-daemon@customer.example', name: 'Mail Delivery System' } }),
    );

    expect(await db.select().from(routingDecisions)).toEqual([]);
    expect(await settleJobs(id)).toEqual([]);
    expect((await ticketRow(id)).routingWindowEndsAt).toBeNull();
  });

  it('starts nothing for a reply on a ticket that already exists', async () => {
    await teams();
    const first = await ingested(mail({ messageId: 'first@customer.example' }));

    const second = await ingested(
      mail({
        messageId: 'second@customer.example',
        inReplyTo: 'first@customer.example',
        references: ['first@customer.example'],
      }),
    );

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await db.select().from(routingDecisions)).toHaveLength(1);
    expect(await settleJobs(first.conversationId)).toHaveLength(1);
  });

  it('records a shadow mailbox’s tickets and holds nothing', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));

    const { conversationId: id } = await ingested(mail());

    expect(await decision(id)).toMatchObject({ shadow: true, stage: 'holding', outcome: null });
    expect(await ticketRow(id)).toMatchObject({
      routingWindowEndsAt: null,
      assigneeAgentId: t.home.agent,
    });
    expect(await settleJobs(id)).toHaveLength(1);
  });

  it('commits with the ticket or not at all', async () => {
    const t = await teams();
    const plan = await planRouting({
      id: t.channel,
      type: 'email',
      config: {},
      routingMode: 'category',
    });
    expect(plan).toEqual({ start: 'live', channelId: t.channel, windowMinutes: 5 });
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });

    // A duplicate delivery's insert, rolled back by the unique index after the
    // hold was written: neither the row nor the job — nor the job's key — survives.
    await expect(
      db.transaction(async (tx) => {
        const [ticket] = await tx
          .insert(conversations)
          .values({
            channel: 'email',
            channelId: t.channel,
            groupId: t.home.group,
            statusId: await status('Open'),
            requesterContactId: contact!.id,
          })
          .returning({ id: conversations.id });
        const [message] = await tx
          .insert(messages)
          .values({
            conversationId: ticket!.id,
            direction: 'inbound',
            kind: 'reply',
            bodyText: 'Hi',
          })
          .returning({ id: messages.id });
        await startRouting(tx, plan, {
          conversationId: ticket!.id,
          messageId: message!.id,
          groupId: t.home.group,
        });
        throw new Error('duplicate key value violates unique constraint');
      }),
    ).rejects.toThrow('duplicate key');

    expect(await db.select().from(routingDecisions)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.type, 'settle_routing'))).toEqual([]);
  });
});

describe('planRouting', () => {
  it('starts nothing for a ticket filed under no row, a coexistence number or the bot', async () => {
    expect(await planRouting(null)).toBeNull();
    expect(
      await planRouting({ id: null, type: 'whatsapp', config: {}, routingMode: 'category' }),
    ).toBeNull();
    expect(
      await planRouting({
        id: '00000000-0000-4000-8000-000000000001',
        type: 'whatsapp',
        config: { coexistence: { onboardedAt: '2026-09-01T10:00:00.000Z', wabaId: 'waba-1' } },
        routingMode: 'category',
      }),
    ).toBeNull();
    expect(
      await planRouting({
        id: '00000000-0000-4000-8000-000000000001',
        type: 'whatsapp_bot',
        config: {},
        routingMode: 'category',
      }),
    ).toBeNull();
  });

  it('plans a shadow record on a shadow channel, with the window it would have had', async () => {
    await classifier('apply', 7);
    expect(
      await planRouting({
        id: '00000000-0000-4000-8000-000000000001',
        type: 'instagram',
        config: {},
        routingMode: 'category_shadow',
      }),
    ).toEqual({
      start: 'shadow',
      channelId: '00000000-0000-4000-8000-000000000001',
      windowMinutes: 7,
    });
  });

  it('starts nothing for a ticket somebody holds from its insert, or one filed as spam', async () => {
    const t = await teams();
    const plan = { start: 'live' as const, channelId: t.channel, windowMinutes: 5 };
    const owned = await heldTicket(t.channel, t.home.group, { stage: 'pending' });
    await db.delete(routingDecisions);
    await db.delete(jobs);

    await db.transaction(async (tx) => {
      await startRouting(tx, plan, {
        conversationId: owned.id,
        messageId: owned.messageId,
        groupId: t.home.group,
        assigneeAgentId: t.home.agent,
      });
      await startRouting(tx, plan, {
        conversationId: owned.id,
        messageId: owned.messageId,
        groupId: t.home.group,
        isSpam: true,
      });
    });

    expect(await db.select().from(routingDecisions)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.type, 'settle_routing'))).toEqual([]);
  });
});

// --- The race into the creation pass ----------------------------------------

describe('the race into the creation pass', () => {
  it('holds the priority classifier’s update pass, which can beat it', async () => {
    const t = await teams();
    await rule('on_update', 'Assign in the group', always, [
      { type: 'auto_assign', groupId: null, strategy: 'group_default' },
    ]);
    // As the insert leaves it: nothing of the creation pass has run.
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    await afterTicketUpdate(id);

    expect((await ticketRow(id)).assigneeAgentId).toBeNull();
    expect(await events(id, 'assignment_skipped')).toEqual([]);
    expect(await decision(id)).toMatchObject({ stage: 'pending', outcome: null });
  });

  it('holds an on_create rule’s auto_assign with no group', async () => {
    const t = await teams();
    await rule('on_create', 'Assign new mail', always, [
      { type: 'auto_assign', groupId: null, strategy: 'group_default' },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({ groupId: t.home.group, assigneeAgentId: null });
    expect(await events(id, 'assignment_skipped')).toEqual([]);
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null });
  });

  it('lets Jev’s early answer write the category and nothing else, then routes on it', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    jevAnswers('sales');
    const { id, messageId } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    expect(await classifyMessageCategory(messageId, { baseUrl: BASE })).toMatchObject({
      status: 'recorded',
      outcome: 'applied',
    });

    // The category, and not one thing more: no decision, no move, nobody.
    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.home.group,
      assigneeAgentId: null,
      routingDecidedAt: null,
    });
    expect(await decision(id)).toMatchObject({ stage: 'pending', outcome: null });
    expect(await events(id, 'routed')).toEqual([]);

    // The creation pass gets there: a rule has had its word, and it routes.
    expect(await beginRouting(id)).toBe('routed');

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({
      decidedByLabel: 'creation',
      categoryId: sales,
      probability: 0.9,
    });
    expect((await events(id, 'routed'))[0]!.data).toMatchObject({
      by: 'creation',
      probability: 0.9,
    });
  });

  it('routes once when Jev answers while beginRouting holds the ticket', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    jevAnswers('sales');
    const { id, messageId } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    // beginRouting has locked the ticket and moved the row to holding; Jev's
    // write waits on the lock, and then finds the row holding.
    const hold = holdNextTransaction('after');
    const begun = beginRouting(id);
    await hold.atHold;
    const classified = classifyMessageCategory(messageId, { baseUrl: BASE });
    await untilWaitingOnALock(db);
    hold.release();

    expect(await begun).toBe('continue');
    expect(await classified).toMatchObject({ outcome: 'applied' });
    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'jev:category' });
  });

  it('routes once when beginRouting waits on Jev’s write', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    jevAnswers('sales');
    const { id, messageId } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    // Jev has written the category under the lock and read the row pending;
    // beginRouting waits, and then finds the category settled.
    const hold = holdNextTransaction('after');
    const classified = classifyMessageCategory(messageId, { baseUrl: BASE });
    await hold.atHold;
    const begun = beginRouting(id);
    await untilWaitingOnALock(db);
    hold.release();

    expect(await classified).toMatchObject({ outcome: 'applied' });
    expect(await begun).toBe('routed');
    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'creation' });
  });
});

describe('beginRouting, best-effort', () => {
  it('answers continue when it fails, and the window’s end decides as though it had begun', async () => {
    errorsExpected = true;
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    const spy = vi
      .spyOn(PgDatabase.prototype, 'transaction')
      .mockImplementationOnce(() => Promise.reject(new Error('the connection was lost')));
    expect(await beginRouting(id)).toBe('continue');
    spy.mockRestore();

    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      `[routing] could not begin routing ${id}`,
    ]);
    expect(await decision(id)).toMatchObject({ stage: 'pending' });
    expect(await settleRouting(id)).toBe('decided');
    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
    await expectDecided(id, 'fallback');
  });

  it('does nothing on a ticket that never entered routing', async () => {
    const t = await teams();
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });
    await db.delete(routingDecisions).where(eq(routingDecisions.conversationId, id));

    expect(await beginRouting(id)).toBe('continue');
    expect(await events(id, 'routed')).toEqual([]);
  });
});

// --- A rule gets the first word ---------------------------------------------

describe('a rule gets the first word', () => {
  it('routes at once on an on_create set_category', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_create', 'Pricing questions are sales', always, [
      { type: 'set_category', categoryId: sales },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({
      categoryId: sales,
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({ decidedByLabel: 'creation' });
    expect(await settleRouting(id)).toBe('none');
    await expectDecided(id, 'category');
  });

  it('ends the hold as rule on an on_create assign_group to another group', async () => {
    const t = await teams();
    await rule('on_create', 'Merchant mail to Merchant Care', always, [
      { type: 'assign_group', groupId: t.care.group },
    ]);

    const { conversationId: id } = await ingested(mail());

    // The creation pass assigned it there itself, the hold being over.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    expect(await expectDecided(id, 'rule')).toMatchObject({
      decidedByLabel: 'automation:Merchant mail to Merchant Care',
      fromGroupId: t.home.group,
      toGroupId: t.care.group,
    });
    expect(await settleRouting(id)).toBe('none');
    await expectDecided(id, 'rule');
  });

  it('ends the hold as rule on an on_create auto_assign naming another group', async () => {
    const t = await teams();
    await rule('on_create', 'Merchant mail to Merchant Care', always, [
      { type: 'auto_assign', groupId: t.care.group, strategy: 'group_default' },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    await expectDecided(id, 'rule');
  });

  it('leaves the hold for an on_create rule naming the group the ticket is in', async () => {
    const t = await teams();
    await rule('on_create', 'Mail to Customer Care', always, [
      { type: 'assign_group', groupId: t.home.group },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null });
  });

  it('sends the out-of-hours reply once, at creation, when a rule ended the hold', async () => {
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    await rule('on_create', 'Merchant mail to Merchant Care', always, [
      { type: 'assign_group', groupId: t.care.group },
    ]);

    const { conversationId: id } = await ingested(mail());
    expect(await acknowledgements(id)).toHaveLength(1);

    expect(await settleRouting(id)).toBe('none');
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('holds the out-of-hours reply at creation when nothing decided', async () => {
    await closedEverywhere();
    await outOfHoursReply();
    await teams();

    const { conversationId: id } = await ingested(mail());
    expect(await acknowledgements(id)).toEqual([]);

    expect(await settleRouting(id)).toBe('decided');
    expect(await acknowledgements(id)).toHaveLength(1);
  });
});

describe('a customer writing again during the hold', () => {
  it('is held with the first message, and the reply that goes answers the opening one', async () => {
    await closedEverywhere();
    await outOfHoursReply();
    const t = await teams();
    const first = await ingested(mail({ messageId: 'first@customer.example' }));
    const second = await ingested(
      mail({
        messageId: 'second@customer.example',
        from: { address: 'amira@customer.example', name: 'Amira' },
        inReplyTo: 'first@customer.example',
        references: ['first@customer.example'],
        textBody: 'Any news?',
      }),
    );
    expect(second.conversationId).toBe(first.conversationId);
    const id = first.conversationId;

    // The reply branch's assignment and acknowledgement are held like the
    // creation pass's.
    expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
    expect(await acknowledgements(id)).toEqual([]);

    expect(await settleRouting(id)).toBe('decided');

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.home.agent);
    expect(await acknowledgements(id)).toHaveLength(1);
    expect(await decision(id)).toMatchObject({ messageId: first.messageId });
  });
});

describe('the creation pass and the SLA', () => {
  it('leaves an on_create rule’s category with its policy when the route moves nothing', async () => {
    const t = await teams();
    const sales = await routeTo('sales', null);
    const policy = await policies(sales);
    await rule('on_create', 'Pricing questions are sales', always, [
      { type: 'set_category', categoryId: sales },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await expectDecided(id, 'no_route_for_category')).toMatchObject({
      toGroupId: t.home.group,
    });
    // Chosen once, by the creation pass, from the rule's category — and the
    // router's re-selection, finding the same, says nothing.
    expect((await ticketRow(id)).slaPolicyId).toBe(policy.sales);
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('chooses the policy once when an on_create rule’s category moves the ticket', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const policy = await policies(sales);
    await rule('on_create', 'Pricing questions are sales', always, [
      { type: 'set_category', categoryId: sales },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      slaPolicyId: policy.sales,
    });
    expect(await events(id, 'sla_recalculated')).toEqual([]);
  });

  it('gives a held ticket its policy before the window ends', async () => {
    const t = await teams();
    const sales = await routeTo('sales', t.sales.group);
    const policy = await policies(sales);

    const { conversationId: id } = await ingested(mail());

    // Chosen in its default group while it waits, so a ticket the window ends
    // on without a category is never one without a policy.
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      slaPolicyId: policy.standard,
      assigneeAgentId: null,
    });
  });
});

describe('a shadow mailbox at creation', () => {
  it('records the would-be decision on a rule’s category, and assigns where the ticket is', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_create', 'Pricing questions are sales', always, [
      { type: 'set_category', categoryId: sales },
    ]);

    const { conversationId: id } = await ingested(mail());

    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
      routingWindowEndsAt: null,
    });
    expect(await expectDecided(id, 'category')).toMatchObject({
      shadow: true,
      toGroupId: t.sales.group,
      decidedByLabel: 'creation',
    });
  });

  it('records a pending shadow row on Jev’s answer once the creation pass begins it', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const sales = await routeTo('sales', t.sales.group);
    jevAnswers('sales');
    const { id, messageId } = await heldTicket(t.channel, t.home.group, {
      shadow: true,
      stage: 'pending',
    });

    await classifyMessageCategory(messageId, { baseUrl: BASE });
    // Pending: a rule gets the first word in shadow too, so nothing is recorded yet.
    expect(await decision(id)).toMatchObject({ stage: 'pending', outcome: null });

    expect(await beginRouting(id)).toBe('continue');
    expect(await expectDecided(id, 'category')).toMatchObject({
      shadow: true,
      decidedByLabel: 'creation',
      probability: 0.9,
    });
    expect(await ticketRow(id)).toMatchObject({ categoryId: sales, groupId: t.home.group });
  });
});

describe('a shadow ticket Jev answers once it is begun', () => {
  it('records the would-be decision, then relabels as though routing did not exist', async () => {
    const t = await teams();
    await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.id, t.channel));
    const sales = await routeTo('sales', t.sales.group);
    await rule('on_update', 'Tag sales', inCategory(sales), [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    jevAnswers('sales');
    const { id, messageId } = await heldTicket(t.channel, t.home.group, { shadow: true });

    await classifyMessageCategory(messageId, { baseUrl: BASE });

    expect(await expectDecided(id, 'category')).toMatchObject({
      shadow: true,
      toGroupId: t.sales.group,
      decidedByLabel: 'jev:category',
    });
    // The update pass and the assignment a relabel owes, in the group the
    // ticket is in: shadow moves nothing.
    const [row] = await db
      .select({ tags: conversations.tags })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row!.tags).toEqual(['sales']);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.home.group,
      assigneeAgentId: t.home.agent,
    });
  });
});

describe('runAutomations, on a held ticket', () => {
  it('an on_create assign_agent ends the hold, as rule', async () => {
    const t = await teams();
    await rule('on_create', 'VIP to Samir', always, [
      { type: 'assign_agent', agentId: t.sales.agent },
    ]);
    const { id } = await heldTicket(t.channel, t.home.group, { stage: 'pending' });

    await runAutomations('on_create', id);

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.sales.agent);
    await expectDecided(id, 'rule');
    // The creation pass carries on as without routing.
    expect(await beginRouting(id)).toBe('continue');
  });
});
