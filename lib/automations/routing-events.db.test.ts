import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { beginRouting } from '@/lib/routing/begin';
import { routingWindowValues, startRouting } from '@/lib/routing/start';
import { withCleanDatabase } from '@/lib/testing/db';
import { runAutomations } from './index';

/**
 * The order of the lines a rule's decision leaves on a held ticket's timeline
 * (`plans/ticket-category-routing.md`, decision 5). The write that ended the
 * hold reads first and the `routed` line naming it second, as the console's
 * group and assignee cases write them: a rule's `assign_group`, a grouped
 * `auto_assign` and an `assign_agent` once wrote their own line after the
 * commit, where `endHold` had stamped `routed` inside it (`CHANGE_STAMP`), so
 * the page read "routed by the rule" before the move or the assignment it was
 * routed by.
 *
 * The order is asked of Postgres, as the ticket page draws it — by
 * `created_at` — with whether each line sorts strictly after the one before:
 * stamps microseconds apart inside one transaction tie in a JavaScript `Date`,
 * which would hide exactly the misordering this looks for.
 *
 * Every best-effort step logs instead of throwing: a test fails on any error
 * logged it did not ask for.
 */

withCleanDatabase();

let errors: MockInstance;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
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

/** A group that assigns round robin at any hour, so who is picked never depends on the clock. */
async function group(name: string, members: string[]): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
    .returning({ id: groups.id });
  await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  return row!.id;
}

/** A mailbox routing by category into Customer Care, and a Sales team elsewhere. */
async function teams() {
  const hana = await agent('Hana Care');
  const samir = await agent('Samir Sales');
  const care = await group('Customer Care', [hana]);
  const sales = await group('Sales', [samir]);
  const [mailbox] = await db
    .insert(channels)
    .values({
      type: 'email',
      name: 'Support mail',
      config: {},
      defaultGroupId: care,
      routingMode: 'category',
    })
    .returning({ id: channels.id });
  return { hana, samir, care, sales, channelId: mailbox!.id };
}

/**
 * A new mail on the mailbox, held as the creation pass leaves it: the window
 * on its insert, the routing row and the job beside it, and begun — `holding`,
 * with no category.
 */
async function heldTicket(channelId: string, groupId: string): Promise<string> {
  people += 1;
  const now = new Date();
  const plan = { start: 'live', channelId, windowMinutes: 5 } as const;
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
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
      statusId: open!.id,
      requesterContactId: contact!.id,
      subject: 'Where is my parcel?',
      lastMessageAt: now,
      lastCustomerMessageAt: now,
      ...routingWindowValues(plan, {}, now),
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
    startRouting(tx, plan, { conversationId: id, messageId: message!.id, groupId }, now),
  );
  expect(await beginRouting(id)).toBe('continue');
  return id;
}

async function onUpdate(name: string, actions: unknown[]): Promise<void> {
  await db
    .insert(automationRules)
    .values({ name, trigger: 'on_update', conditions: { all: [] }, actions });
}

const LINES = ['group_changed', 'assigned', 'unassigned', 'routed'];

/** The lines in the order the ticket page draws them, each with whether it sorts after the one before. */
async function timelineOf(id: string) {
  return db
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      afterPrevious: sql<boolean>`coalesce(${conversationEvents.createdAt} > lag(${conversationEvents.createdAt}) over (order by ${conversationEvents.createdAt}, ${conversationEvents.id}), true)`,
    })
    .from(conversationEvents)
    .where(and(eq(conversationEvents.conversationId, id), inArray(conversationEvents.type, LINES)))
    .orderBy(asc(conversationEvents.createdAt), asc(conversationEvents.id));
}

async function decisionOf(id: string) {
  const [row] = await db
    .select({ outcome: routingDecisions.outcome, toGroupId: routingDecisions.toGroupId })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, id));
  return row!;
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

/** Refuses every `type` line on the timeline until `drop` is called. */
async function refuseLine(type: string) {
  await db.execute(sql`
    create function refuse_line() returns trigger language plpgsql
    as $$ begin raise exception 'refused for the test'; end $$`);
  await db.execute(
    sql.raw(`
    create trigger refuse_line before insert on conversation_events
    for each row when (new.type = '${type}') execute function refuse_line()`),
  );
  return async () => {
    await db.execute(sql`drop trigger refuse_line on conversation_events`);
    await db.execute(sql`drop function refuse_line()`);
  };
}

// --- Tests ------------------------------------------------------------------

describe('a rule ending a routing hold', () => {
  const RULE = 'automation:Sales mail goes to Sales';

  it('assign_group: the move, then the routed line naming it', async () => {
    const { care, sales, samir, channelId } = await teams();
    await onUpdate('Sales mail goes to Sales', [{ type: 'assign_group', groupId: sales }]);
    const id = await heldTicket(channelId, care);

    await runAutomations('on_update', id);

    expect(await decisionOf(id)).toEqual({ outcome: 'rule', toGroupId: sales });
    // The hold's follow-up, once the pass is over, assigns in the rule's group.
    expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: samir });
    expect(await timelineOf(id)).toEqual([
      { type: 'group_changed', actorLabel: RULE, afterPrevious: true },
      { type: 'routed', actorLabel: RULE, afterPrevious: true },
      { type: 'assigned', actorLabel: 'auto_assign', afterPrevious: true },
    ]);
  });

  it('a grouped auto_assign: the move, then the routed line, then the pick', async () => {
    const { care, sales, samir, channelId } = await teams();
    await onUpdate('Sales mail goes to Sales', [
      { type: 'auto_assign', groupId: sales, strategy: 'group_default' },
    ]);
    const id = await heldTicket(channelId, care);

    await runAutomations('on_update', id);

    expect(await decisionOf(id)).toEqual({ outcome: 'rule', toGroupId: sales });
    expect(await ticketRow(id)).toMatchObject({ groupId: sales, assigneeAgentId: samir });
    expect(await timelineOf(id)).toEqual([
      { type: 'group_changed', actorLabel: RULE, afterPrevious: true },
      { type: 'routed', actorLabel: RULE, afterPrevious: true },
      { type: 'assigned', actorLabel: RULE, afterPrevious: true },
    ]);
  });

  it('assign_agent: the assignment, then the routed line naming it', async () => {
    const { care, samir, channelId } = await teams();
    await onUpdate('Sales mail goes to Sales', [{ type: 'assign_agent', agentId: samir }]);
    const id = await heldTicket(channelId, care);

    await runAutomations('on_update', id);

    expect(await decisionOf(id)).toEqual({ outcome: 'rule', toGroupId: care });
    expect(await ticketRow(id)).toMatchObject({ groupId: care, assigneeAgentId: samir });
    expect(await timelineOf(id)).toEqual([
      { type: 'assigned', actorLabel: RULE, afterPrevious: true },
      { type: 'routed', actorLabel: RULE, afterPrevious: true },
    ]);
  });

  // The line is written in the move's transaction now, in a savepoint of its
  // own: refused, it is logged and rolled back to, and the move, the hold's
  // end and the assignment they owe all stand — as they did while the line
  // was written after the commit.
  it.each([
    ['assign_group', { type: 'assign_group' }],
    ['a grouped auto_assign', { type: 'auto_assign', strategy: 'group_default' }],
  ] as const)(
    '%s whose group_changed is refused still moves the ticket and ends the hold',
    async (_, action) => {
      const { care, sales, samir, channelId } = await teams();
      await onUpdate('Sales mail goes to Sales', [{ ...action, groupId: sales }]);
      const id = await heldTicket(channelId, care);

      const drop = await refuseLine('group_changed');
      try {
        await runAutomations('on_update', id);
      } finally {
        await drop();
      }

      expect(await decisionOf(id)).toEqual({ outcome: 'rule', toGroupId: sales });
      const row = await ticketRow(id);
      expect(row).toMatchObject({ groupId: sales, assigneeAgentId: samir });
      expect(row.routingDecidedAt).toBeInstanceOf(Date);
      expect((await timelineOf(id)).map((line) => line.type)).toEqual(['routed', 'assigned']);
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('could not record'),
      ]);
      errors.mockClear();
    },
  );
});
