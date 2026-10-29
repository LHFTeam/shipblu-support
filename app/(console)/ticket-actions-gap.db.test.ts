import { AsyncLocalStorage } from 'node:async_hooks';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  messages,
  slaPolicies,
  ticketCategories,
  ticketFields,
  ticketStatuses,
} from '@/db/schema';
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { routeNow, type RouteResult } from '@/lib/routing/apply';
import { beginRouting } from '@/lib/routing/begin';
import { routingWindowValues, startRouting } from '@/lib/routing/start';
import { applySlaOnCreate } from '@/lib/sla';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The console's other writers on a decision in flight — priority, tags, a
 * custom field and the status — against Postgres. Each lands while the router
 * finishes a decision: phase one written, its pass claimed and reading the
 * ticket as it was, the hold not yet ended.
 *
 * Each runs a pass over the `on_update` rules of its own, as the category,
 * group and assignee cases do, and for the reason they hand theirs to the
 * router (`deferToRouter`): a pass of the edit's own is unordered with the
 * router's end of the hold, and when it comes after, a rule keyed on what the
 * edit wrote moves the ticket away from the agent the router has just handed
 * it to — `assign_group` never touches an assignee. So a rule moving an urgent
 * ticket to Escalations left Omar in Sales holding it there.
 *
 * Except a status that takes the ticket out of anybody's queue: the router
 * gives its pass up on a ticket nobody may work, so handed to it, a resolve's
 * own rules would never run.
 *
 * The router's calls and the edit's are told apart by who opened each
 * transaction (`routeWithEditBetween`), so the edit lands at a named point in
 * the decision, and anything it does after its write waits until the router
 * has finished — the lag that made the order matter, made certain. The
 * harness is the one `ticket-actions.db.test.ts` uses, copied rather than
 * imported, since a test file is not a module the next one may lean on.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));

/** How many of the next reads of the hours catalog fail, as a lost connection would fail them. */
const catalog = vi.hoisted(() => ({ failing: 0 }));
vi.mock('@/lib/hours/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/hours/catalog')>();
  return {
    ...real,
    loadHoursCatalog: async () => {
      if (catalog.failing > 0) {
        catalog.failing -= 1;
        throw new Error('the hours catalog could not be read');
      }
      return real.loadHoursCatalog();
    },
  };
});

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
  await classifierApplies();
});

afterEach(() => {
  catalog.failing = 0;
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

async function onUpdate(name: string, conditions: unknown, actions: unknown[], position = 0) {
  await db
    .insert(automationRules)
    .values({ name, trigger: 'on_update', conditions, actions, position });
}

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

async function mailbox(defaultGroupId: string) {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'email',
      name: 'Support mail',
      config: {},
      defaultGroupId,
      routingMode: 'category',
    })
    .returning({ id: channels.id });
  return row!.id;
}

async function statusId(name: string) {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

/**
 * An email ticket on `channelId`'s mail, held as the insert holds one — the
 * window on the insert, the routing row and its job beside it — and begun as
 * the creation pass begins it: `holding`, with no category yet.
 */
async function heldTicket(channelId: string, groupId: string) {
  people += 1;
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: `amira${people}@customer.example` })
    .returning({ id: contacts.id });
  const plan = { start: 'live', channelId, windowMinutes: 5 } as const;
  const now = new Date();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      channelId,
      groupId,
      statusId: await statusId('Open'),
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      lastMessageAt: now,
      lastCustomerMessageAt: now,
      ...routingWindowValues(plan, {}, now),
    })
    .returning({ id: conversations.id });
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: row!.id,
      direction: 'inbound',
      kind: 'reply',
      bodyText: 'Hello, my parcel has not arrived.',
      createdAt: now,
    })
    .returning({ id: messages.id });
  await db.transaction((tx) =>
    startRouting(tx, plan, { conversationId: row!.id, messageId: message!.id, groupId }, now),
  );
  expect(await beginRouting(row!.id)).toBe('continue');
  return row!.id;
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
      statusId: conversations.statusId,
      tags: conversations.tags,
      routingDecidedAt: conversations.routingDecidedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

/**
 * The ticket's lines of these types in the order the page draws them, by
 * `created_at`: whether the rules ran before anybody was assigned.
 */
async function linesOf(id: string, types = ['routed', 'tagged', 'group_changed', 'assigned']) {
  const rows = await db
    .select({ type: conversationEvents.type })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, types)))
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
  return rows.map((row) => row.type);
}

/**
 * Home, where the mailbox files new mail; Sales, where sales routes; and
 * Escalations, where a rule keyed on the edit sends the ticket. A held ticket
 * Jev has filed as sales, which the router then decides on. Every pass tags
 * the ticket `seen`, so the timeline counts them.
 */
async function desk() {
  const hana = await agent('Hana Home');
  const omar = await agent('Omar Sales');
  const ezz = await agent('Ezz Escalations');
  const home = await group('Home', [hana]);
  const sales = await group('Sales', [omar]);
  const escalations = await group('Escalations', [ezz]);
  const salesCategory = await routeTo('sales', sales);
  const id = await heldTicket(await mailbox(home), home);
  expect(
    (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
  ).toBe('changed');
  await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
  return { omar, ezz, sales, escalations, id };
}

const routeJev = (id: string) => () => routeNow(id, { label: 'jev:category' });

// --- Tests ------------------------------------------------------------------

/** One console writer: what it posts, and the rule keyed on what it writes. */
type Writer = {
  field: string;
  value: () => Promise<string>;
  condition: { field: string; op: string; value: string };
};

const writers: [string, Writer][] = [
  [
    'a priority edit',
    {
      field: 'priority',
      value: async () => 'urgent',
      condition: { field: 'priority', op: 'eq', value: 'urgent' },
    },
  ],
  [
    'a tags edit',
    {
      field: 'tags',
      value: async () => 'vip',
      condition: { field: 'tags', op: 'contains', value: 'vip' },
    },
  ],
  [
    'a custom field edit',
    {
      field: 'custom:warehouse',
      value: async () => {
        await db
          .insert(ticketFields)
          .values({ key: 'warehouse', label: 'Warehouse', type: 'text' });
        return 'Alexandria';
      },
      condition: { field: 'custom.warehouse', op: 'eq', value: 'Alexandria' },
    },
  ],
  [
    'a move to Pending',
    {
      field: 'status',
      value: () => statusId('Pending'),
      condition: { field: 'status.category', op: 'eq', value: 'pending' },
    },
  ],
];

describe('updateTicket on a decision in flight: the other writers', () => {
  // The edit lands once the router's pass has read the ticket — at medium,
  // untagged, open — and before its phase three, with its own follow-ups
  // lagging the router. The pass did not see the edit; phase three finds it
  // re-armed and runs it again on what the edit wrote, so the rule keyed on
  // it moves the ticket before anybody is handed it. Run by the console after
  // the router, the rule moved the ticket to Escalations with Omar, assigned
  // in Sales a moment before, still holding it.
  it.each(writers)(
    '%s during the router’s pass: its rules move the ticket before anybody is assigned',
    async (_, writer) => {
      const d = await desk();
      await onUpdate(
        'Goes to Escalations',
        writer.condition,
        [{ type: 'assign_group', groupId: d.escalations }],
        1,
      );
      const value = await writer.value();

      // Phase one, then the claim that reads the ticket for the pass: the edit
      // lands after that read and before the pass acts on it.
      const { routed, edited } = await routeWithEditBetween({
        route: routeJev(d.id),
        afterRouterTransaction: 2,
        edit: () => edit(d.id, writer.field, value),
      });

      expect(routed).toBe('decided');
      expect(edited).toMatchObject({ error: null });
      expect(await ticketRow(d.id)).toMatchObject({
        groupId: d.escalations,
        assigneeAgentId: d.ezz,
      });
      // The pass that read the ticket before the edit, the one that read the
      // edit and moved the ticket on, and only then the assignment — and no
      // pass of the edit's own after it.
      expect(await linesOf(d.id)).toEqual([
        'routed',
        'tagged',
        'tagged',
        'group_changed',
        'assigned',
      ]);
    },
  );

  // A resolve is not handed to the router. The router owes a ticket nobody
  // may work no pass at all, so the pass a resolve re-armed would be given up
  // on the resolved ticket it found, and the rules keyed on the resolve would
  // never run. Nothing races its own pass either: the router assigns nobody a
  // resolved ticket.
  it('a resolve during the router’s pass runs its own rules', async () => {
    const d = await desk();
    await onUpdate(
      'Note the resolve',
      { field: 'status.category', op: 'eq', value: 'resolved' },
      [{ type: 'add_tags', tags: ['resolved-by-hand'] }],
      1,
    );
    const resolved = await statusId('Resolved');

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 2,
      edit: () => edit(d.id, 'status', resolved),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    const row = await ticketRow(d.id);
    expect(row).toMatchObject({ statusId: resolved, groupId: d.sales, assigneeAgentId: null });
    expect(row.routingDecidedAt).not.toBeNull();
    expect([...row.tags].sort()).toEqual(['resolved-by-hand', 'seen']);
    // The router's one pass, on the ticket still open; then the resolve's own,
    // both of its rules; and nobody assigned.
    expect(await linesOf(d.id, ['routed', 'tagged', 'assigned'])).toEqual([
      'routed',
      'tagged',
      'tagged',
      'tagged',
    ]);
  });
});

/** Every console field that hands its pass to a decision in flight, and a rule keyed on it. */
const deferringEdits: [string, (d: Awaited<ReturnType<typeof desk>>) => Promise<Writer>][] = [
  [
    'a category edit',
    async () => {
      const [support] = await db
        .select({ id: ticketCategories.id })
        .from(ticketCategories)
        .where(eq(ticketCategories.key, 'customer_support'));
      return {
        field: 'category',
        value: async () => support!.id,
        condition: { field: 'category.id', op: 'eq', value: support!.id },
      };
    },
  ],
  [
    'a group move',
    async (d) => ({
      field: 'group',
      value: async () => d.escalations,
      condition: { field: 'group.id', op: 'eq', value: d.escalations },
    }),
  ],
  [
    'naming an assignee',
    async (d) => ({
      field: 'assignee',
      value: async () => d.ezz,
      condition: { field: 'assignee.id', op: 'eq', value: d.ezz },
    }),
  ],
  ...writers
    .filter(([, writer]) => writer.field !== 'status')
    .map(([name, writer]) => [name, async () => writer] as [string, () => Promise<Writer>]),
];

// Each edit on a ticket nobody may work any more, its decision in flight:
// phase one written while the ticket was open, and the resolve — here written
// straight to the row, as a rule, a merge or a spam mark would leave it —
// landing before the router's pass is claimed, the edit after it. The router
// owes such a ticket no pass, and gives its pass up as it claims it
// (`phaseTwo`), so an edit handing its pass to the router there handed it to
// nobody, and no rule keyed on what it wrote ever ran. The same edit on a
// resolved ticket that never routed runs its own pass, and so does one on a
// ticket resolved before phase one, which the router decides `not_open`; so
// does this one, which the router has no pass left to run for.
describe('an edit on a ticket nobody may work, its decision in flight', () => {
  it.each(deferringEdits)('%s runs its own rules', async (_, writerFor) => {
    const d = await desk();
    const writer = await writerFor(d);
    await onUpdate(
      'Keyed on the edit',
      writer.condition,
      [{ type: 'add_tags', tags: ['rule-ran'] }],
      1,
    );
    const value = await writer.value();
    const resolved = await statusId('Resolved');

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 1,
      edit: async () => {
        await db
          .update(conversations)
          .set({ statusId: resolved, resolvedAt: new Date() })
          .where(eq(conversations.id, d.id));
        return edit(d.id, writer.field, value);
      },
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    const row = await ticketRow(d.id);
    expect(row.routingDecidedAt).not.toBeNull();
    expect(row.tags).toContain('rule-ran');
    // The router ran no pass on the resolved ticket and assigned nobody: the
    // one pass is the edit's, both of its rules.
    expect(await linesOf(d.id, ['routed', 'tagged'])).toEqual(['routed', 'tagged', 'tagged']);
    expect(row.assigneeAgentId).toBe(writer.field === 'assignee' ? d.ezz : null);
  });
});

/** Round the clock, so a target is wall-clock minutes; urgent owes a first response in five. */
async function roundTheClockPolicy() {
  const row = { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 480 };
  await db.insert(slaPolicies).values({
    name: 'Round the clock',
    hoursSource: 'round_the_clock',
    targets: {
      low: row,
      medium: row,
      high: row,
      urgent: { firstResponseMins: 5, nextResponseMins: 5, resolutionMins: 480 },
    },
    isDefault: true,
  });
}

/** The ticket as though it arrived `minutes` ago, with the clocks it got then. */
async function arrivedAgo(id: string, minutes: number) {
  await db
    .update(conversations)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(conversations.id, id));
  await applySlaOnCreate(id);
}

async function firstResponseDue(id: string) {
  const [row] = await db
    .select({ due: conversations.firstResponseDueAt })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.due!;
}

// An edit that moves the clocks, landing once the router's pass has read the
// ticket. Without routing, the console re-times the clocks and then runs the
// pass, so a rule asking `is_first_response_overdue` reads the clock the edit
// produced (`afterTicketUpdate`). Handed to the router, the edit runs no pass,
// and the router's runs again the moment the edit commits: re-timed after that
// commit, unordered with the pass, the clock that pass read was the one from
// before the edit, and no pass followed the re-time.
describe('an edit that moves the clocks, on a decision in flight', () => {
  // Ten minutes old at medium, due at sixty. Raised to urgent it was due at
  // five, and is overdue: the rule moves it before anybody is assigned. Once
  // the router's pass read medium's deadline, matched nothing, and Omar was
  // given a ticket owed an escalation that never came.
  it('a priority raise: the rule asking whether it is overdue reads the new deadline', async () => {
    await roundTheClockPolicy();
    const d = await desk();
    await arrivedAgo(d.id, 10);
    expect((await firstResponseDue(d.id)).getTime()).toBeGreaterThan(Date.now());
    await onUpdate(
      'Overdue escalates',
      { field: 'is_first_response_overdue', op: 'eq', value: true },
      [{ type: 'assign_group', groupId: d.escalations }],
      1,
    );

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 2,
      edit: () => edit(d.id, 'priority', 'urgent'),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect((await firstResponseDue(d.id)).getTime()).toBeLessThan(Date.now());
    expect(await ticketRow(d.id)).toMatchObject({
      groupId: d.escalations,
      assigneeAgentId: d.ezz,
    });
    expect(await linesOf(d.id, ['priority_changed', 'sla_recalculated'])).toEqual([
      'priority_changed',
      'sla_recalculated',
    ]);
  });

  // The re-time is best-effort inside the write as it was after it. Refused —
  // its timeline line, here, as a trigger would refuse it — it is rolled back
  // to its own savepoint and logged, and the priority, the hand-over and the
  // router's pass on the urgent ticket all stand. (The router's re-time for
  // its own move, after the hold, then prices the clocks at urgent anyway.)
  it('a priority raise whose re-time is refused: the write and the router’s pass stand', async () => {
    await roundTheClockPolicy();
    const d = await desk();
    await arrivedAgo(d.id, 10);
    await onUpdate(
      'Urgent is seen',
      { field: 'priority', op: 'eq', value: 'urgent' },
      [{ type: 'add_tags', tags: ['urgent-seen'] }],
      1,
    );
    await db.execute(sql`
      create function refuse_recalculated() returns trigger language plpgsql
      as $$ begin raise exception 'refused for the test'; end $$`);
    await db.execute(sql`
      create trigger refuse_recalculated before insert on conversation_events
      for each row when (new.type = 'sla_recalculated' and new.data->>'reason' = 'priority')
      execute function refuse_recalculated()`);

    let result: { routed: RouteResult; edited: unknown };
    try {
      result = await routeWithEditBetween({
        route: routeJev(d.id),
        afterRouterTransaction: 2,
        edit: () => edit(d.id, 'priority', 'urgent'),
      });
    } finally {
      await db.execute(sql`drop trigger refuse_recalculated on conversation_events`);
      await db.execute(sql`drop function refuse_recalculated()`);
    }

    expect(result.routed).toBe('decided');
    expect(result.edited).toMatchObject({ error: null });
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining(`could not move the clocks on ${d.id}`),
    ]);
    errors.mockClear();
    const [written] = await db
      .select({ priority: conversations.priority })
      .from(conversations)
      .where(eq(conversations.id, d.id));
    expect(written!.priority).toBe('urgent');
    const row = await ticketRow(d.id);
    expect(row).toMatchObject({ groupId: d.sales, assigneeAgentId: d.omar });
    expect(row.tags).toContain('urgent-seen');
    expect(row.routingDecidedAt).not.toBeNull();
  });

  // Seventy minutes old, parked on Pending since its fifth: due ten minutes
  // ago by the deadline it was given, and fifty-five minutes from now once the
  // hour it spent parked is credited as the clock resumes. Moved back to Open,
  // it is not overdue, and the rule escalating open overdue tickets must not
  // fire. Once the router's pass read the open ticket with the deadline from
  // before the resume and sent it to Escalations.
  it('a move back to Open: the rule asking whether it is overdue reads the resumed deadline', async () => {
    await roundTheClockPolicy();
    const d = await desk();
    await arrivedAgo(d.id, 70);
    const [ticket] = await db
      .select({ createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, d.id));
    const parkedAt = new Date(ticket!.createdAt.getTime() + 5 * 60_000);
    await db
      .update(conversations)
      .set({ statusId: await statusId('Pending') })
      .where(eq(conversations.id, d.id));
    await db.insert(conversationEvents).values({
      conversationId: d.id,
      type: 'sla_paused',
      actorLabel: 'sla',
      createdAt: parkedAt,
      data: { at: parkedAt.toISOString() },
    });
    expect((await firstResponseDue(d.id)).getTime()).toBeLessThan(Date.now());
    await onUpdate(
      'Open and overdue escalates',
      {
        all: [
          { field: 'status.category', op: 'eq', value: 'open' },
          { field: 'is_first_response_overdue', op: 'eq', value: true },
        ],
      },
      [{ type: 'assign_group', groupId: d.escalations }],
      1,
    );
    const open = await statusId('Open');

    const { routed, edited } = await routeWithEditBetween({
      route: routeJev(d.id),
      afterRouterTransaction: 2,
      edit: () => edit(d.id, 'status', open),
    });

    expect(routed).toBe('decided');
    expect(edited).toMatchObject({ error: null });
    expect((await firstResponseDue(d.id)).getTime()).toBeGreaterThan(Date.now());
    expect(await ticketRow(d.id)).toMatchObject({ groupId: d.sales, assigneeAgentId: d.omar });
    expect(await linesOf(d.id, ['status_changed', 'sla_resumed'])).toEqual([
      'status_changed',
      'sla_resumed',
    ]);
  });
});

/** A ticket that never entered routing, ten minutes old, with the clocks it got then. */
async function plainTicket(groupId: string) {
  people += 1;
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Plain', primaryEmail: `plain${people}@customer.example` })
    .returning({ id: contacts.id });
  const arrived = new Date(Date.now() - 10 * 60_000);
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'email',
      groupId,
      statusId: await statusId('Open'),
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      lastMessageAt: arrived,
      lastCustomerMessageAt: arrived,
      createdAt: arrived,
    })
    .returning({ id: conversations.id });
  await applySlaOnCreate(row!.id);
  return row!.id;
}

async function priorityOf(id: string) {
  const [row] = await db
    .select({ priority: conversations.priority })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.priority;
}

// The policies and the hours a deferral re-times with inside its write are
// read before that write, and only on a decision in flight
// (`clockInputsIfInFlight`), best-effort. Read for every priority and status
// edit, and outside any try, a catalog that could not be read failed the edit
// itself, where the edit had always been written and the re-time's failure
// logged after it — the SLA's promise that a write never fails for its clocks.
describe('the clocks’ policies and hours, unreadable', () => {
  it.each([
    ['a priority edit', 'priority'],
    ['a move to Pending', 'status'],
  ] as const)('%s on a ticket that never routed is written all the same', async (_, field) => {
    await roundTheClockPolicy();
    const id = await plainTicket(await group('Home', []));
    const value = field === 'priority' ? 'urgent' : await statusId('Pending');

    catalog.failing = Infinity;
    const result = await edit(id, field, value);
    catalog.failing = 0;

    expect(result).toMatchObject({ error: null });
    if (field === 'priority') expect(await priorityOf(id)).toBe('urgent');
    else expect((await ticketRow(id)).statusId).toBe(value);
    // The re-time after the commit, best-effort as it always was.
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringMatching(new RegExp(`could not (move|pause or resume) the clock.* ${id}`)),
    ]);
    errors.mockClear();
  });

  // On a decision in flight, the edit landing once the router's pass has read
  // the ticket, with the catalog unreadable for the read before its write. It
  // is written, its pass handed to the router — whose second pass runs before
  // anybody is assigned — and the clocks move after its commit instead, which
  // the router's pass may then read too late: the cost the in-write re-time
  // exists to avoid, paid only here. Sales routes to Home, so the router moves
  // nothing and re-times nothing of its own that could hide whether the
  // edit's re-time ran.
  it.each([
    ['a priority raise', 'priority'],
    ['a move to Pending', 'status'],
  ] as const)(
    '%s on a decision in flight is written, defers, and moves the clocks after its commit',
    async (_, field) => {
      await roundTheClockPolicy();
      const hana = await agent('Hana Home');
      const home = await group('Home', [hana]);
      const salesCategory = await routeTo('sales', home);
      const id = await heldTicket(await mailbox(home), home);
      await arrivedAgo(id, 10);
      expect(
        (await setConversationCategory(id, salesCategory, { label: 'jev:category' })).outcome,
      ).toBe('changed');
      await onUpdate('Count passes', { all: [] }, [{ type: 'add_tags', tags: ['seen'] }], 0);
      const value = field === 'priority' ? 'urgent' : await statusId('Pending');

      const { routed, edited } = await routeWithEditBetween({
        route: routeJev(id),
        afterRouterTransaction: 2,
        edit: () => {
          catalog.failing = 1;
          return edit(id, field, value);
        },
      });

      expect(routed).toBe('decided');
      expect(edited).toMatchObject({ error: null });
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
        `[routing] could not load the clocks' policies and hours for ${id}`,
      ]);
      errors.mockClear();
      if (field === 'priority') expect(await priorityOf(id)).toBe('urgent');
      else expect((await ticketRow(id)).statusId).toBe(value);
      // The pass that read the ticket before the edit, the one that read it,
      // and only then the assignment — no pass of the edit's own after it.
      expect(await linesOf(id, ['routed', 'tagged', 'assigned'])).toEqual([
        'routed',
        'tagged',
        'tagged',
        'assigned',
      ]);
      expect(await ticketRow(id)).toMatchObject({ groupId: home, assigneeAgentId: hana });
      if (field === 'priority') {
        expect((await firstResponseDue(id)).getTime()).toBeLessThan(Date.now());
        expect(await linesOf(id, ['priority_changed', 'sla_recalculated'])).toEqual([
          'priority_changed',
          'sla_recalculated',
        ]);
      } else {
        expect(await linesOf(id, ['status_changed', 'sla_paused'])).toEqual([
          'status_changed',
          'sla_paused',
        ]);
      }
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
 * write waits until the router has finished: the edit's follow-ups lagging the
 * router, made certain. Transactions are told apart by who opened them, so the
 * router's own steps and the edit's are counted apart however they interleave.
 */
async function routeWithEditBetween({
  route,
  afterRouterTransaction,
  edit: editing,
}: {
  route: () => Promise<RouteResult>;
  afterRouterTransaction: number;
  edit: () => Promise<unknown>;
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
      if (nth > 1) await released;
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
