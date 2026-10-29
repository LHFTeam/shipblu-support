import { AsyncLocalStorage } from 'node:async_hooks';
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
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { routeNow, settleRouting, type RouteResult } from '@/lib/routing/apply';
import { beginRouting } from '@/lib/routing/begin';
import { endHold } from '@/lib/routing/end-hold';
import { routingWindowValues, startRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction } from '@/lib/testing/hold-transaction';

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

/** An SLA policy's targets, the same at every priority. */
const target = (firstResponseMins: number, resolutionMins: number) => {
  const row = { firstResponseMins, nextResponseMins: firstResponseMins, resolutionMins };
  return { low: row, medium: row, high: row, urgent: row };
};
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
 * A ticket on `channelId`'s mail, started as the insert starts one — the
 * window on the insert (`routingWindowValues`), the row and the job beside it
 * — and, unless `stage` stops it there, begun as the creation pass begins it:
 * `holding`, with no category. Live, the window is on the ticket and nothing
 * assigns it; in shadow nothing is held.
 */
async function heldTicket(
  channelId: string,
  groupId: string,
  { shadow = false, stage = 'holding' }: { shadow?: boolean; stage?: 'pending' | 'holding' } = {},
) {
  const plan = { start: shadow ? 'shadow' : 'live', channelId, windowMinutes: 5 } as const;
  const now = new Date();
  const t = await ticket(groupId, { channelId, ...routingWindowValues(plan, {}, now) });
  await db.transaction((tx) =>
    startRouting(tx, plan, { conversationId: t.id, messageId: t.messageId, groupId }, now),
  );
  if (stage === 'holding') expect(await beginRouting(t.id)).toBe('continue');
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

/** Refuses every `type` line on the timeline until the answer is called. */
async function refuseLine(type: string) {
  await db.execute(sql`
    create function refuse_line() returns trigger language plpgsql
    as $$ begin raise exception 'refused for the test'; end $$`);
  await db.execute(
    sql.raw(`create trigger refuse_line before insert on conversation_events
      for each row when (new.type = '${type}') execute function refuse_line()`),
  );
  return async () => {
    await db.execute(sql`drop trigger refuse_line on conversation_events`);
    await db.execute(sql`drop function refuse_line()`);
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

  // The move and the unassignment have committed when the rota throws, so the
  // answer is a success that says who holds the ticket is not known — not a
  // failure for a hand-over that stands. A trigger refusing the `assigned`
  // line stands in for whatever throws.
  it('says so when assigning in the new group failed after the hand-over', async () => {
    const { lina, care, sales, salesCategory } = await desk();
    const { id } = await ticket(care, { categoryId: salesCategory, assigneeAgentId: lina });
    const drop = await refuseLine('assigned');
    let answer;
    try {
      answer = await handTo(id, sales, lina);
    } finally {
      await drop();
    }

    expect(answer).toMatchObject({
      error: null,
      message:
        'Handed to Inbound Sales Team, but assigning it there failed. Check who holds it now.',
    });
    expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: null });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('after handing it over'),
    ]);
    errors.mockClear();
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

    // The creation pass has not reached `beginRouting` yet. Routed now, the
    // ticket was decided before its `on_create` rules had run — a rule's
    // `assign_group` then ended nothing — so the edit writes the category and
    // nothing else: no decision, no pass over the rules, no policy chosen.
    // `beginRouting` routes on it once the rules have had the first word.
    it('on a ticket not yet begun, writes the category and leaves the routing to beginRouting', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      await db.insert(slaPolicies).values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: target(30, 240),
        position: 0,
        conditions: { field: 'category.id', op: 'eq', value: salesCategory },
      });
      await onUpdate('Every update is urgent', { all: [] }, [
        { type: 'set_priority', value: 'urgent' },
      ]);
      const id = await heldTicket(await mailbox(care, 'category'), care, { stage: 'pending' });

      expect(await edit(id, 'category', salesCategory)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({ stage: 'pending', outcome: null });
      expect(await eventsOf(id, 'routed')).toEqual([]);
      expect(await eventsOf(id, 'priority_changed')).toEqual([]);
      expect(await eventsOf(id, 'sla_recalculated')).toEqual([]);
      expect(await ticketRow(id)).toMatchObject({
        groupId: care,
        assigneeAgentId: null,
        routingDecidedAt: null,
      });

      // The creation pass's routing step, then: on the person's category.
      expect(await beginRouting(id)).toBe('routed');
      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'category',
        categoryId: salesCategory,
        toGroupId: sales,
        decidedByLabel: 'creation',
      });
      expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: omar });
      expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
    });

    // In shadow too a rule gets the first word: the would-be decision waits
    // for `beginRouting`, after the `on_create` rules, and the edit is the
    // relabel it would be without routing — its own pass included, since
    // nothing is held and the router runs no rules on a shadow row.
    it('on a shadow ticket not yet begun, records nothing and relabels', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      await onUpdate('Every update is urgent', { all: [] }, [
        { type: 'set_priority', value: 'urgent' },
      ]);
      const id = await heldTicket(await mailbox(care, 'category_shadow'), care, {
        shadow: true,
        stage: 'pending',
      });

      expect(await edit(id, 'category', salesCategory)).toMatchObject({ error: null });

      expect(await decisionOf(id)).toMatchObject({ stage: 'pending', outcome: null });
      expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
      // Nothing holds a shadow ticket, so the edit's own pass assigned it.
      expect(await ticketRow(id)).toMatchObject({ groupId: care, assigneeAgentId: lina });

      // The creation pass then records where it would have gone, as `creation`.
      expect(await beginRouting(id)).toBe('continue');
      expect(await decisionOf(id)).toMatchObject({
        shadow: true,
        stage: 'decided',
        outcome: 'category',
        toGroupId: sales,
        decidedByLabel: 'creation',
      });
      expect(await ticketRow(id)).toMatchObject({ groupId: care, assigneeAgentId: lina });
    });

    // The window closes in the moment between the edit's commit and its own
    // call into the router: `settle_routing`, waiting on the edit's lock,
    // decides on the category the edit wrote and runs the rules on it. The
    // edit meets that decision made (`none`) or finishing (`in_flight`), and
    // a pass of its own would be a second over the same category — every
    // rule keyed on it fires twice. The edit's write is held open from
    // inside it, so the settle is queued on the ticket's lock first.
    it('runs no pass of its own when the router decided on the category it wrote', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      await onUpdate('Every update is urgent', { all: [] }, [
        { type: 'set_priority', value: 'urgent' },
      ]);
      const id = await heldTicket(await mailbox(care, 'category'), care);

      const write = holdNextTransaction('after');
      const editing = edit(id, 'category', salesCategory);
      await write.atHold;
      const settling = settleRouting(id);
      await untilWaitingOnLocks(1, () => false);
      write.release();

      expect(await settling).toBe('decided');
      expect(await editing).toMatchObject({ error: null });
      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'category',
        categoryId: salesCategory,
        toGroupId: sales,
        decidedByLabel: 'settle_routing',
      });
      expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: omar });
      expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
    });

    // Between the edit's commit and its call into the router an agent takes
    // the ticket, which `endHold` decides without looking at the category:
    // nothing has run the rules on what the edit wrote, so the edit does.
    it('runs its own pass when a person decided in that moment', async () => {
      const lina = await agent('Lina Care');
      const omar = await agent('Omar Sales');
      const care = await group('Customer Care', [lina]);
      const sales = await group('Inbound Sales Team', [omar]);
      const salesCategory = await routeTo('sales', sales);
      await onUpdate('Every update is urgent', { all: [] }, [
        { type: 'set_priority', value: 'urgent' },
      ]);
      await onUpdate(
        'Sales is seen',
        { field: 'category.id', op: 'eq', value: salesCategory },
        [{ type: 'add_tags', tags: ['sales-seen'] }],
        1,
      );
      const id = await heldTicket(await mailbox(care, 'category'), care);

      const write = holdNextTransaction('after');
      const editing = edit(id, 'category', salesCategory);
      await write.atHold;
      const taking = db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ assigneeAgentId: lina, assignedAt: new Date() })
          .where(eq(conversations.id, id));
        return endHold(tx, id, 'manual', { agentId: lina });
      });
      await untilWaitingOnLocks(1, () => false);
      write.release();

      expect(await taking).toBe(true);
      expect(await editing).toMatchObject({ error: null });
      expect(await decisionOf(id)).toMatchObject({
        stage: 'decided',
        outcome: 'manual',
        toGroupId: care,
        decidedByAgentId: lina,
      });
      expect(await ticketRow(id)).toMatchObject({ groupId: care, assigneeAgentId: lina });
      expect(await tagsOf(id)).toEqual(['sales-seen']);
      expect(await eventsOf(id, 'priority_changed')).toHaveLength(1);
    });

    // Jev's answer routed the ticket a moment ago, and its pass over the rules
    // read the ticket filed as Sales; the agent files it as merchant work
    // while that pass is still going. The router's pass will never see the
    // new category, so the edit re-arms it (`deferToRouter`) and runs none of
    // its own: the router's phase three finds the pass owed again and runs it
    // on merchant work before it ends the hold — or the rule keyed on merchant
    // work never fires. The first rule's row is held from outside to stop the
    // router's pass between its two rules.
    it('re-arms the router’s pass when it meets a decision part-way through, whose rules read the old category', async () => {
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
        // An edit running a pass of its own would stop at the same rule; one
        // that hands its pass to the router returns.
        await untilWaitingOnLocks(2, () => edited);
      } finally {
        await rule.release();
      }
      expect(await routing).toBe('decided');
      expect(await editing).toMatchObject({ error: null });

      expect(await tagsOf(id)).toEqual(expect.arrayContaining(['seen', 'merchant-work']));
      // A pass for the decision and one for the edit, merchant work's in the second only.
      expect(await linesOf(id, ['tagged'])).toEqual(['tagged', 'tagged', 'tagged']);
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

/**
 * A console edit landing while the router finishes a decision — phase one
 * written, the hold not yet ended. The edit runs no `on_update` pass of its
 * own: it re-arms the router's (`deferToRouter`), whose pass reads what the
 * edit wrote before the router's end of the hold assigns anybody. Run beside
 * the router's, the edit's pass was unordered with that assignment: when it
 * came after, a rule in it moved the ticket away from the agent the router had
 * just handed it to, and `assign_group` left them holding it.
 *
 * The router's calls and the edit's are told apart by who opened each
 * transaction (`routeWithEditBetween`), so the edit lands at a named point in
 * the decision, and anything it does after its write waits until the router
 * has finished — the lag that made the order matter, made certain.
 */
describe('updateTicket on a decision in flight', () => {
  beforeEach(async () => {
    await classifierApplies();
  });

  /** Home, where the mailbox files new mail; Customer Care; and Sales, where sales routes. */
  async function desk() {
    const hana = await agent('Hana Home');
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const home = await group('Home', [hana]);
    const care = await group('Customer Care', [lina]);
    const sales = await group('Sales', [omar]);
    const salesCategory = await routeTo('sales', sales);
    const [support] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'customer_support'));
    const id = await heldTicket(await mailbox(home, 'category'), home);
    // Jev's answer, which the router then decides on.
    expect(
      (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
    ).toBe('changed');
    return { lina, omar, home, care, sales, salesCategory, support: support!.id, id };
  }

  const routeJev = (id: string) => () => routeNow(id, { label: 'jev:category' });

  // The edit lands the moment phase one commits, and its follow-ups lag the
  // router. Once, the router found the category changed, gave its pass up to
  // the edit and assigned Omar in Sales; the edit's pass then moved the ticket
  // to Customer Care with Omar still holding it.
  it('a category edit after phase one: its rules move the ticket before anybody is assigned', async () => {
    const d = await desk();
    await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
    await onUpdate(
      'Support goes to Customer Care',
      { field: 'category.id', op: 'eq', value: d.support },
      [{ type: 'assign_group', groupId: d.care }],
      1,
    );

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 1,
      edit: () => edit(d.id, 'category', d.support),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.care, assigneeAgentId: d.lina });
    // One pass, the router's, on the person's category, before the assignment.
    expect(await linesOf(d.id)).toEqual([
      'category_changed',
      'routed',
      'category_changed',
      'tagged',
      'group_changed',
      'assigned',
    ]);
  });

  // The edit lands once the router's pass has read the ticket — on Sales —
  // and before its phase three, with its follow-ups lagging the router. The
  // pass did not see Billing; phase three finds it re-armed and runs it again
  // there, so the rule moving Billing on is obeyed before anybody is handed
  // the ticket. Run by the console after the router, it moved the ticket away
  // from the Billing agent the router had just assigned.
  it('a group move during the router’s pass: the pass runs again on the move, before the assignment', async () => {
    const d = await desk();
    const bilal = await agent('Bilal Billing');
    const billing = await group('Billing', [bilal]);
    await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
    await onUpdate(
      'Billing goes to Customer Care',
      inGroup(billing),
      [{ type: 'assign_group', groupId: d.care }],
      1,
    );

    // Phase one, then the claim that reads the ticket for the pass: the move
    // lands after that read and before the pass acts on it.
    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 2,
      edit: () => edit(d.id, 'group', billing),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.care, assigneeAgentId: d.lina });
    // The person's move; the pass that read Sales, and the one that read
    // Billing and moved the ticket on; and only then the assignment.
    expect(await linesOf(d.id, ['routed', 'group_changed', 'tagged', 'assigned'])).toEqual([
      'routed',
      'group_changed',
      'tagged',
      'tagged',
      'group_changed',
      'assigned',
    ]);
    expect(await decisionOf(d.id)).toMatchObject({
      stage: 'decided',
      outcome: 'category',
      toGroupId: d.sales,
    });
  });

  // The same moment for a category edit: the pass that read Sales is not the
  // person's, and the one that reads customer support runs once — not once
  // by the router and again by the edit.
  it('a category edit during the router’s pass: its rules run once, before the assignment', async () => {
    const d = await desk();
    await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
    await onUpdate(
      'Support goes to Customer Care',
      { field: 'category.id', op: 'eq', value: d.support },
      [{ type: 'assign_group', groupId: d.care }],
      1,
    );

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 2,
      edit: () => edit(d.id, 'category', d.support),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.care, assigneeAgentId: d.lina });
    expect(await linesOf(d.id, ['routed', 'group_changed', 'tagged', 'assigned'])).toEqual([
      'routed',
      'tagged',
      'tagged',
      'group_changed',
      'assigned',
    ]);
  });

  // Naming an assignee in the gap: the assignment stands, and the router's
  // pass is the one the edit is owed — one pass, not the router's and then
  // the edit's own over the same ticket.
  it('naming an assignee after phase one: the router’s one pass, and the person’s pick stands', async () => {
    const d = await desk();
    const bilal = await agent('Bilal Billing');
    await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }]);

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 1,
      edit: () => edit(d.id, 'assignee', bilal),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.sales, assigneeAgentId: bilal });
    expect(await linesOf(d.id, ['routed', 'tagged', 'assigned'])).toEqual([
      'routed',
      'assigned',
      'tagged',
    ]);
    expect(await decisionOf(d.id)).toMatchObject({ stage: 'decided', outcome: 'category' });
  });

  // The edit's own call into the router would fail — a lost connection — and
  // that was once read as "the window's job runs the rules". With a decision
  // on another category in flight, the router gave its pass up to the edit,
  // decided the row, and the window's job found nothing to do: no rule keyed
  // on what the person chose ever ran. Handed to the router under the edit's
  // lock, the pass runs whatever the edit's later calls would have done.
  it('a category edit whose own call into the router would fail: its rules still run, once', async () => {
    const d = await desk();
    await onUpdate('Tag support', { field: 'category.id', op: 'eq', value: d.support }, [
      { type: 'add_tags', tags: ['support'] },
    ]);

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 1,
      edit: () => edit(d.id, 'category', d.support),
      afterWrite: 'refused',
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    // The window's job, at its end, finds the decision made.
    expect(await settleRouting(d.id, new Date(Date.now() + 6 * 60_000))).toBe('none');
    expect(await tagsOf(d.id)).toEqual(['support']);
    expect(await linesOf(d.id, ['tagged'])).toEqual(['tagged']);
  });

  // No gate on the edit at all: phase one stops on its routing row, which
  // another transaction holds, with the ticket's lock taken; the edit queues
  // behind it, and both are let go. Which of the router's claim and the
  // edit's write then comes first is the database's to decide, and every
  // order gives one answer: a write before the claim is read by the one pass,
  // and one after it re-arms a pass that did not read it. With the claim in a
  // statement of its own and the pass reading the ticket a moment later, an
  // edit committing in between was passed by both, in about half of runs.
  it('a category edit queued behind phase one: its rules run once, before the assignment', async () => {
    const d = await desk();
    await onUpdate(
      'Support goes to Customer Care',
      { field: 'category.id', op: 'eq', value: d.support },
      [
        { type: 'assign_group', groupId: d.care },
        { type: 'add_tags', tags: ['support-pass'] },
      ],
    );

    const row = await holdRoutingRow(d.id);
    let routing: Promise<RouteResult> = Promise.resolve('none');
    let editing: Promise<unknown> = Promise.resolve();
    try {
      let done = false;
      routing = routeNow(d.id, { label: 'jev:category' }).finally(() => (done = true));
      await untilWaitingOnLocks(1, () => done);
      editing = edit(d.id, 'category', d.support);
      await untilWaitingOnLocks(2, () => done);
    } finally {
      await row.release();
    }
    expect(await routing).toBe('decided');
    expect(await editing).toMatchObject({ error: null });

    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.care, assigneeAgentId: d.lina });
    expect(await linesOf(d.id, ['tagged'])).toEqual(['tagged']);
  });

  // An edit whose transaction began while phase one held the ticket's lock,
  // and wrote once phase one had committed. Stamped when its transaction
  // began, its line sorted before the `routed` it came after, and the page
  // read as the router overruling the person.
  it.each(['group', 'assignee'] as const)(
    'a %s edit that waited on phase one is drawn after the decision',
    async (field) => {
      const d = await desk();
      const bilal = await agent('Bilal Billing');
      const billing = await group('Billing', [bilal]);

      const row = await holdRoutingRow(d.id);
      let routing: Promise<RouteResult> = Promise.resolve('none');
      let editing: Promise<unknown> = Promise.resolve();
      try {
        let done = false;
        routing = routeNow(d.id, { label: 'jev:category' }).finally(() => (done = true));
        await untilWaitingOnLocks(1, () => done);
        editing = edit(d.id, field, field === 'group' ? billing : bilal);
        await untilWaitingOnLocks(2, () => done);
      } finally {
        await row.release();
      }
      expect(await routing).toBe('decided');
      expect(await editing).toMatchObject({ error: null });

      const lines = await db
        .select({ type: conversationEvents.type, actorAgentId: conversationEvents.actorAgentId })
        .from(conversationEvents)
        .where(
          and(
            eq(conversationEvents.conversationId, d.id),
            inArray(conversationEvents.type, ['routed', 'group_changed', 'assigned']),
          ),
        )
        .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
      const routedAt = lines.findIndex((line) => line.type === 'routed');
      const personAt = lines.findIndex((line) => line.actorAgentId === signedIn.id);
      expect(routedAt).toBeGreaterThanOrEqual(0);
      expect(personAt).toBeGreaterThan(routedAt);
    },
  );
});

/** Who opened a transaction: the router's call, or the console's edit. */
const opener = new AsyncLocalStorage<'router' | 'edit'>();

/**
 * Runs `route` with `edit` landing once the router's `afterRouterTransaction`th
 * transaction has committed (1 is phase one), before the router goes on — the
 * edit's write commits there, as `edit` is run in full then unless it opens a
 * transaction after its write. Every transaction the edit opens after its
 * write waits until the router has finished, or with `afterWrite: 'refused'`
 * fails as a lost connection does: the edit's follow-ups lagging the router,
 * made certain. Transactions are told apart by who opened them, so the
 * router's own steps and the edit's are counted apart however they interleave.
 */
async function routeWithEditBetween({
  route,
  afterRouterTransaction,
  edit: editing,
  afterWrite = 'held',
}: {
  route: () => Promise<RouteResult>;
  afterRouterTransaction: number;
  edit: () => Promise<unknown>;
  afterWrite?: 'held' | 'refused';
}): Promise<{ routed: RouteResult; edited: unknown }> {
  const real = PgDatabase.prototype.transaction;
  let routerOpened = 0;
  let editOpened = 0;
  let edited: Promise<unknown> | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let wrote!: () => void;
  const written = new Promise<void>((resolve) => (wrote = resolve));

  const spy = vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementation(async function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    const who = opener.getStore();
    if (who === 'edit') {
      const nth = ++editOpened;
      if (nth > 1) {
        if (afterWrite === 'refused') throw new Error('the connection was lost');
        await released;
      }
      const result: unknown = await real.call(this, run, config);
      if (nth === 1) wrote();
      return result as never;
    }
    if (who === 'router') {
      const nth = ++routerOpened;
      const result: unknown = await real.call(this, run, config);
      if (nth === afterRouterTransaction) {
        edited = opener.run('edit', editing);
        await Promise.race([written, edited]);
      }
      return result as never;
    }
    return real.call(this, run, config) as never;
  });

  try {
    const routed = await opener.run('router', route);
    release();
    return { routed, edited: await edited };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Holds the ticket's routing row from another transaction until released, so
 * the router's phase one stops on it with the ticket's lock already taken —
 * where an edit then queues behind it.
 */
async function holdRoutingRow(conversationId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const holding = db.transaction(async (tx) => {
    await tx
      .select({ id: routingDecisions.id })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, conversationId))
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

/**
 * The ticket's lines of these types in the order the page draws them, by
 * `created_at`: whether the rules ran before anybody was assigned.
 */
async function linesOf(
  id: string,
  types: string[] = ['routed', 'category_changed', 'group_changed', 'tagged', 'assigned'],
) {
  const rows = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, types)))
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
  return rows.map((row) => row.type);
}

// A held ticket resolved in its window meets a person's category edit as any
// resolved ticket does. The router decides it `not_open` and runs no pass, so
// that is not the edit's pass having run, and the edit runs its own.
describe('a category edit on a ticket resolved in its window', () => {
  beforeEach(async () => {
    await classifierApplies();
  });

  it.each([
    ['held', true],
    ['never routed', false],
  ] as const)('runs the update rules, held or never routed (%s)', async (_, routed) => {
    const lina = await agent('Lina Care');
    const omar = await agent('Omar Sales');
    const care = await group('Customer Care', [lina]);
    const sales = await group('Sales', [omar]);
    const salesKey = await routeTo('sales', sales);
    await onUpdate('Tag sales', { field: 'category.id', op: 'eq', value: salesKey }, [
      { type: 'add_tags', tags: ['sales'] },
    ]);
    const id = routed
      ? await heldTicket(await mailbox(care, 'category'), care)
      : (await ticket(care)).id;
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    await db
      .update(conversations)
      .set({ statusId: resolved!.id, resolvedAt: new Date() })
      .where(eq(conversations.id, id));

    expect(await edit(id, 'category', salesKey)).toMatchObject({ error: null });
    expect(await tagsOf(id)).toEqual(['sales']);
  });
});
