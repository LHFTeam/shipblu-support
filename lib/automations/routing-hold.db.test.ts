import { and, asc, eq, sql } from 'drizzle-orm';
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
  ticketStatuses,
} from '@/db/schema';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { settleRouting } from '@/lib/routing/apply';
import { beginRouting } from '@/lib/routing/begin';
import { startRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';
import { runTimeAutomations } from '@/worker/handlers/run-time-automations';
import { runAutomations } from './index';

/**
 * The automation engine on a ticket held for routing
 * (`plans/ticket-category-routing.md`, decision 5): which actions end the hold
 * — as `rule`, in the transaction of the write that ends it — and that the
 * pass then pays what the hold kept back, the assignment and the held
 * out-of-hours reply, once it is over.
 *
 * Only an action that changes something ends a hold: `assign_agent` naming an
 * agent, `assign_group` to another group, `auto_assign` naming another group.
 * A rule naming the group the ticket is already in matches on every pass, and
 * must not end every hold on its channel; one that clears the assignee decides
 * nothing about where the ticket goes.
 *
 * The held reply is how "what the hold owed was paid" is seen here: the
 * seeded calendar is shut for good, so every group is closed and the
 * acknowledgement to the opening message goes exactly when the hold ends. The
 * groups assign at any hour, so who is picked never depends on the clock.
 *
 * A ticket is started through `startRouting` and begun through `beginRouting`,
 * exactly as the creation pass leaves a held ticket, on the real clock.
 * Every best-effort step logs instead of throwing: a test fails on any error
 * logged it did not ask for.
 */

withCleanDatabase();

let errors: MockInstance;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, 'apply', 0.6, 5)
    on conflict (id) do update set mode = excluded.mode`);
  forgetCategoryAiSettings();
  await closedEverywhere();
  await db
    .insert(autoResponses)
    .values({ bodyEn: 'Thanks — we are closed, and will reply when we open.' });
});

afterEach(() => {
  const logged = errors.mock.calls.map((call) => String(call[0]));
  vi.restoreAllMocks();
  expect(logged).toEqual([]);
});

// --- Fixtures ---------------------------------------------------------------

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

async function group(name: string, members: string[]): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
    .returning({ id: groups.id });
  await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  return row!.id;
}

/** The seeded default calendar, shut every day: every group is closed now. */
async function closedEverywhere(): Promise<void> {
  const day: { start: string; end: string }[] = [];
  await db
    .update(businessHours)
    .set({ schedule: { sun: day, mon: day, tue: day, wed: day, thu: day, fri: day, sat: day } })
    .where(eq(businessHours.isDefault, true));
  forgetHoursCatalog();
}

/** A mailbox routing by category, its own team, and a second team elsewhere. */
async function teams() {
  const home = { agent: await agent('Hana') };
  const sales = { agent: await agent('Samir') };
  const homeGroup = await group('Customer Care', [home.agent]);
  const salesGroup = await group('Sales', [sales.agent]);
  const [mailbox] = await db
    .insert(channels)
    .values({
      type: 'email',
      name: 'Support mail',
      config: {},
      defaultGroupId: homeGroup,
      routingMode: 'category',
    })
    .returning({ id: channels.id });
  return {
    home: { ...home, group: homeGroup },
    sales: { ...sales, group: salesGroup },
    channel: mailbox!.id,
  };
}

async function openStatus(): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return row!.id;
}

/**
 * A new mail on the mailbox, started as its insert starts it and, unless
 * `stage` stops it there, begun as the creation pass begins it: `holding`.
 */
async function heldTicket(
  channelId: string,
  groupId: string,
  { stage = 'holding', shadow = false }: { stage?: 'pending' | 'holding'; shadow?: boolean } = {},
): Promise<string> {
  people += 1;
  const now = new Date();
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
      statusId: await openStatus(),
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      lastMessageAt: now,
      lastCustomerMessageAt: now,
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
      createdAt: now,
    })
    .returning({ id: messages.id });
  await db.transaction((tx) =>
    startRouting(
      tx,
      { start: shadow ? 'shadow' : 'live', channelId, windowMinutes: 5 },
      { conversationId: id, messageId: message!.id, groupId },
      now,
    ),
  );
  if (stage === 'holding') expect(await beginRouting(id)).toBe('continue');
  return id;
}

async function rule(
  trigger: 'on_create' | 'on_update' | 'time_based',
  name: string,
  actions: unknown[],
): Promise<void> {
  await db.insert(automationRules).values({ name, trigger, conditions: { all: [] }, actions });
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

async function decision(id: string) {
  const [row] = await db
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, id));
  return row!;
}

async function events(id: string, type: string) {
  return db
    .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, type)))
    .orderBy(asc(conversationEvents.createdAt));
}

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

/** The SQLSTATE of a failed query, through the wrapper drizzle puts round it. */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Ended by the rule named, in the group the ticket was left in. */
async function expectEndedByRule(id: string, ruleName: string, groupId: string) {
  expect(await decision(id)).toMatchObject({
    stage: 'decided',
    outcome: 'rule',
    toGroupId: groupId,
    decidedByAgentId: null,
    decidedByLabel: `automation:${ruleName}`,
  });
  expect((await ticketRow(id)).routingDecidedAt).toBeInstanceOf(Date);
  const routed = await events(id, 'routed');
  expect(routed).toHaveLength(1);
  expect(routed[0]).toMatchObject({
    actorLabel: `automation:${ruleName}`,
    data: { outcome: 'rule', to: groupId },
  });
}

/** Still held: undecided, no `routed` line, nobody assigned and nothing said. */
async function expectStillHeld(id: string) {
  expect(await decision(id)).toMatchObject({ stage: 'holding', outcome: null, decidedAt: null });
  expect(await ticketRow(id)).toMatchObject({ assigneeAgentId: null, routingDecidedAt: null });
  expect(await events(id, 'routed')).toEqual([]);
  expect(await events(id, 'assignment_skipped')).toEqual([]);
  expect(await acknowledgements(id)).toEqual([]);
}

// --- assign_agent -----------------------------------------------------------

describe('assign_agent on a held ticket', () => {
  it('naming an agent ends the hold as rule, and the pass then sends the held reply', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'Escalate', [{ type: 'assign_agent', agentId: t.sales.agent }]);

    await runAutomations('on_update', id);

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.sales.agent);
    await expectEndedByRule(id, 'Escalate', t.home.group);
    // What the hold kept back, paid once the pass was over: nobody to assign,
    // and the acknowledgement to the opening message.
    expect(await acknowledgements(id)).toHaveLength(1);

    // The window's end finds it decided and records nothing new.
    expect(await settleRouting(id)).toBe('none');
    await expectEndedByRule(id, 'Escalate', t.home.group);
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('clearing the assignee decides nothing, and the hold stays', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'Unassign', [{ type: 'assign_agent', agentId: null }]);

    await runAutomations('on_update', id);

    await expectStillHeld(id);
  });
});

// --- assign_group -----------------------------------------------------------

describe('assign_group on a held ticket', () => {
  it('naming the group the ticket is in moves nothing and leaves the hold', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'Keep in care', [{ type: 'assign_group', groupId: t.home.group }]);

    await runAutomations('on_update', id);

    await expectStillHeld(id);
    expect((await ticketRow(id)).groupId).toBe(t.home.group);
    expect(await events(id, 'group_changed')).toEqual([]);
  });

  it('moving it elsewhere ends the hold as rule, and it is assigned there', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'To sales', [{ type: 'assign_group', groupId: t.sales.group }]);

    await runAutomations('on_update', id);

    await expectEndedByRule(id, 'To sales', t.sales.group);
    expect(await events(id, 'routed')).toMatchObject([
      { data: { from: t.home.group, to: t.sales.group, toName: 'Sales', moved: true } },
    ]);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  // The stamp and the move commit together: held after the move's last
  // statement, its transaction already holds the routing row, and neither
  // half is visible to anybody else until it commits. A stamp written after
  // the move committed would leave a ticket moved and still held, for the
  // rota of a group it no longer belongs to.
  it('ends the hold in the transaction that moves the ticket', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'To sales', [{ type: 'assign_group', groupId: t.sales.group }]);

    const { atHold, release } = holdNextTransaction('after');
    const pass = runAutomations('on_update', id);
    await atHold;

    expect(await ticketRow(id)).toMatchObject({ groupId: t.home.group, routingDecidedAt: null });
    expect((await decision(id)).stage).toBe('holding');
    const locked = await db
      .execute(
        sql`select id from routing_decisions where conversation_id = ${id} for update nowait`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(sqlState(locked)).toBe('55P03');

    release();
    await pass;

    expect((await ticketRow(id)).groupId).toBe(t.sales.group);
    await expectEndedByRule(id, 'To sales', t.sales.group);
  });

  // An `on_create` pass is followed by the creation pass, which begins routing
  // on the decided row and carries on into assignment and the reply — so the
  // engine paying them as well would assign before the first SLA selection.
  it('on an on_create pass, leaves what the hold owed to the creation pass', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group, { stage: 'pending' });
    await rule('on_create', 'To sales', [{ type: 'assign_group', groupId: t.sales.group }]);

    await runAutomations('on_create', id);

    await expectEndedByRule(id, 'To sales', t.sales.group);
    expect((await ticketRow(id)).assigneeAgentId).toBeNull();
    expect(await acknowledgements(id)).toEqual([]);
    // The creation pass finds the rule's decision and carries on.
    expect(await beginRouting(id)).toBe('continue');
  });
});

// --- auto_assign ------------------------------------------------------------

describe('auto_assign on a held ticket', () => {
  it('naming another group ends the hold as rule and assigns there, in one call', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'Sales rota', [
      { type: 'auto_assign', groupId: t.sales.group, strategy: 'group_default' },
    ]);

    await runAutomations('on_update', id);

    await expectEndedByRule(id, 'Sales rota', t.sales.group);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('with no group, or the ticket’s own, is held like any other assignment', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('on_update', 'Any rota', [
      { type: 'auto_assign', groupId: null, strategy: 'group_default' },
    ]);
    await rule('on_update', 'Care rota', [
      { type: 'auto_assign', groupId: t.home.group, strategy: 'group_default' },
    ]);

    await runAutomations('on_update', id);

    await expectStillHeld(id);
  });
});

// --- The time-based sweep ---------------------------------------------------

describe('a time-based rule on a held ticket', () => {
  // Nobody follows the sweep: if the engine did not pay what the hold owed,
  // the ticket would wait, unassigned, for the window's end.
  it('moving it elsewhere ends the hold as rule, and the sweep assigns it there', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('time_based', 'Stale to sales', [{ type: 'assign_group', groupId: t.sales.group }]);

    await runTimeAutomations();

    await expectEndedByRule(id, 'Stale to sales', t.sales.group);
    expect(await ticketRow(id)).toMatchObject({
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  it('naming an agent ends the hold as rule', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('time_based', 'Stale to Samir', [{ type: 'assign_agent', agentId: t.sales.agent }]);

    await runTimeAutomations();

    expect((await ticketRow(id)).assigneeAgentId).toBe(t.sales.agent);
    await expectEndedByRule(id, 'Stale to Samir', t.home.group);
    expect(await acknowledgements(id)).toHaveLength(1);
  });

  // A level-triggered rule: it matches every ticket on every sweep, so a stamp
  // here would end every hold on the channel within fifteen minutes.
  it('naming the group the ticket is in leaves the hold', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group);
    await rule('time_based', 'Keep in care', [{ type: 'assign_group', groupId: t.home.group }]);

    await runTimeAutomations();

    await expectStillHeld(id);
  });
});

// --- Shadow -----------------------------------------------------------------

describe('a rule on a ticket a shadow channel is only watching', () => {
  it('records where the rule would have sent it, and holds and owes nothing', async () => {
    const t = await teams();
    const id = await heldTicket(t.channel, t.home.group, { shadow: true });
    await rule('on_update', 'To sales', [{ type: 'assign_group', groupId: t.sales.group }]);

    await runAutomations('on_update', id);

    expect(await decision(id)).toMatchObject({
      shadow: true,
      stage: 'decided',
      outcome: 'rule',
      toGroupId: t.sales.group,
      decidedByLabel: 'automation:To sales',
    });
    expect(await ticketRow(id)).toMatchObject({ groupId: t.sales.group, routingDecidedAt: null });
    expect(await events(id, 'routed')).toEqual([]);
  });
});
