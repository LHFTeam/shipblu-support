import { and, eq, sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  channels,
  contacts,
  conversations,
  groupMembers,
  groups,
  messages,
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { runAutomations } from '@/lib/automations';
import { setConversationCategory } from '@/lib/categories/write';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import { appendVisitorMessage } from '@/lib/widget/conversation';
import { routeNow } from './apply';
import { beginRouting } from './begin';
import { startRouting } from './start';

/**
 * The locks a routing writer takes on a ticket's row, raced against the one
 * writer nothing serialises it with: a customer's message
 * (`plans/ticket-category-routing.md`, decision 5).
 *
 * Every ingest path continuing a ticket inserts the message — whose foreign key
 * takes KEY SHARE on the ticket's row — and then updates the ticket, in one
 * transaction, behind no lock a routing writer ever takes (`lockThread` is an
 * advisory lock on the thread, and the reply and the engine never ask for it).
 * FOR UPDATE conflicts with that KEY SHARE; NO KEY UPDATE, which every UPDATE
 * of the row takes anyway, does not. So:
 *
 * - **After a write**, asking for FOR UPDATE on the row the write already
 *   holds is a deadlock against a message inserted in between: the writer
 *   waits on the message's KEY SHARE, and the message's own UPDATE waits on
 *   the writer. `endHold` did exactly that, behind every agent's reply, every
 *   console move and every rule that assigns, on every ticket, routed or not —
 *   a reply stored and never sent, or the customer's message lost.
 * - **Before a write**, FOR UPDATE deadlocks nothing, but stops every message
 *   inserted on the ticket until the writer commits — the customer's next
 *   message waiting on the router's or the rota's decision.
 *
 * Each case puts the two writers exactly where the deadlock closes, through a
 * pause in front of `endHold` and a transaction held open before it commits,
 * with the message on a connection of its own, or through the real ingest.
 * Without NO KEY UPDATE every one of them fails: `deadlock detected` (40P01),
 * or the message's insert timing out on the lock (55P03).
 */

const gate = vi.hoisted(() => ({
  next: null as null | { reached: () => void; held: Promise<void> },
}));

// `endHold` as it is, with a pause in front of it when a test asks for one:
// the caller has written to the ticket and holds its row, and has not yet
// asked `endHold` for anything. Every importer of the module gets this one.
vi.mock('./end-hold', async (importOriginal) => {
  const real = await importOriginal<typeof import('./end-hold')>();
  return {
    ...real,
    endHold: async (...args: Parameters<typeof real.endHold>) => {
      const pause = gate.next;
      gate.next = null;
      if (pause) {
        pause.reached();
        await pause.held;
      }
      return real.endHold(...args);
    },
  };
});

withCleanDatabase();

let side: postgres.Sql;
let errors: MockInstance;

beforeAll(() => {
  side = postgres(process.env.TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
});

afterAll(async () => {
  await side.end({ timeout: 5 });
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  gate.next = null;
  await db.execute(sql`
    insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
    values (1, 'apply', 0.6, 5)
    on conflict (id) do update set mode = excluded.mode`);
  forgetCategoryAiSettings();
});

afterEach(() => {
  // A deadlock the engine survives is logged rather than thrown: an error
  // logged is a test failed.
  const logged = errors.mock.calls.map((call) => `${call[0]} ${String(call[1] ?? '')}`);
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

async function group(name: string, members: string[] = []): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
    .returning({ id: groups.id });
  if (members.length) {
    await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  }
  return row!.id;
}

/** The widget's channel, routing by category or not at all. */
async function webchat(defaultGroupId: string, routes: boolean): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'webchat',
      name: 'Web chat',
      config: {},
      defaultGroupId,
      routingMode: routes ? 'category' : 'default_group',
    })
    .returning({ id: channels.id });
  return row!.id;
}

type Ticket = { id: string; contactId: string };

/**
 * A visitor's open chat in `groupId`, the visitor's live conversation — held
 * for the router as the insert and the creation pass leave one, or never
 * routed.
 */
async function chat(channelId: string, groupId: string, held: boolean): Promise<Ticket> {
  const now = new Date();
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'webchat',
      channelId,
      groupId,
      statusId: open!.id,
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
      authorContactId: contact!.id,
      bodyText: 'Hi, where is my parcel?',
      createdAt: now,
    })
    .returning({ id: messages.id });
  if (held) {
    await db.transaction((tx) =>
      startRouting(
        tx,
        { start: 'live', channelId, windowMinutes: 5 },
        { conversationId: id, messageId: message!.id, groupId },
        now,
      ),
    );
    expect(await beginRouting(id)).toBe('continue');
  }
  return { id, contactId: contact!.id };
}

/** Stops the next caller of `endHold` in front of it, holding what it wrote. */
function pauseBeforeEndHold() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atPause = new Promise<void>((resolve) => (reached = resolve));
  gate.next = { reached, held };
  return { atPause, release };
}

/**
 * Holds the `nth` transaction opened from now (from 1) after its last
 * statement — every lock it took held, nothing committed — until released.
 * `holdNextTransaction`, for a writer whose lock is not in its first one.
 */
function holdTransaction(nth: number) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atHold = new Promise<void>((resolve) => (reached = resolve));
  const real = PgDatabase.prototype.transaction;
  let opened = 0;
  vi.spyOn(PgDatabase.prototype, 'transaction').mockImplementation(function (
    this: PgDatabase<never>,
    run,
    config,
  ) {
    opened += 1;
    if (opened !== nth) return real.call(this, run, config) as never;
    return real.call(
      this,
      async (tx) => {
        const result = await run(tx);
        reached();
        await held;
        return result;
      },
      config,
    ) as never;
  });
  return { atHold, release };
}

/**
 * A customer's message on its own connection, as every ingest path writes one:
 * the insert, then — once `update()` is called — the ticket's clocks, in one
 * transaction.
 */
function customerWrites(conversationId: string) {
  let inserted!: () => void;
  const insertedAt = new Promise<void>((resolve) => (inserted = resolve));
  let update!: () => void;
  const updating = new Promise<void>((resolve) => (update = resolve));
  const done = side
    .begin(async (tx) => {
      await tx`insert into messages (conversation_id, direction, kind, body_text)
               values (${conversationId}, 'inbound', 'reply', 'Hello? Anybody there?')`;
      inserted();
      await updating;
      await tx`update conversations
               set last_message_at = now(), last_customer_message_at = now()
               where id = ${conversationId}`;
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  return { inserted: insertedAt, update, done };
}

/** A message inserted on the ticket, refused if it waits more than a second on a lock. */
async function insertWhileHeld(conversationId: string): Promise<unknown> {
  return side
    .begin(async (tx) => {
      await tx`set local lock_timeout = '1s'`;
      await tx`insert into messages (conversation_id, direction, kind, body_text)
               values (${conversationId}, 'inbound', 'reply', 'Hello? Anybody there?')`;
    })
    .then(
      () => null,
      (error: unknown) => error,
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

async function inbound(id: string): Promise<number> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, id), eq(messages.direction, 'inbound')));
  return rows.length;
}

async function ticketRow(id: string) {
  const [row] = await db
    .select({
      groupId: conversations.groupId,
      assigneeAgentId: conversations.assigneeAgentId,
      lastAgentMessageAt: conversations.lastAgentMessageAt,
      routingDecidedAt: conversations.routingDecidedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function stage(id: string) {
  const [row] = await db
    .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, id));
  return row ?? null;
}

// --- After a write: endHold -------------------------------------------------

describe('an agent’s reply, and a customer’s message at the same moment', () => {
  /**
   * The reply's update holds the row; the message is inserted; `endHold` runs
   * beside the message's KEY SHARE; the message's own update then waits on the
   * reply, which is held open until it does. Under FOR UPDATE the reply waits
   * on the message and the message on the reply.
   */
  async function race(ticket: Ticket, agentId: string) {
    const reply = pauseBeforeEndHold();
    const commit = holdNextTransaction('after');
    const replying = storeAgentReply(ticket.id, 'webchat', {
      authorAgentId: agentId,
      bodyText: 'It is on its way.',
      deliveryStatus: 'delivered',
      deliveredAt: new Date(),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await reply.atPause;

    const message = customerWrites(ticket.id);
    await message.inserted;
    reply.release();
    await Promise.race([commit.atHold, untilWaitingOnALock(db)]);
    message.update();
    await untilWaitingOnALock(db);
    commit.release();

    return { reply: await replying, message: await message.done };
  }

  it.each([
    ['a ticket that never routed', false],
    ['a ticket held for the router', true],
  ])('both commit, on %s', async (_label, held) => {
    const omar = await agent('Omar');
    const care = await group('Customer Care');
    const ticket = await chat(await webchat(care, held), care, held);

    const { reply, message } = await race(ticket, omar);

    expect(sqlState(reply)).toBeUndefined();
    expect(reply).toBeNull();
    expect(message).toBeNull();
    expect(await inbound(ticket.id)).toBe(2);
    expect((await ticketRow(ticket.id)).lastAgentMessageAt).toBeInstanceOf(Date);
    if (held) {
      expect(await stage(ticket.id)).toEqual({ stage: 'decided', outcome: 'manual' });
      expect((await ticketRow(ticket.id)).routingDecidedAt).toBeInstanceOf(Date);
    } else {
      expect(await stage(ticket.id)).toBeNull();
    }
  });
});

describe('a rule’s assign_group, and the visitor’s next message at the same moment', () => {
  /**
   * The rule's move holds the row; the real widget ingest continues the chat
   * — its insert goes through, its update waits on the move; then `endHold`
   * runs, and the move is held open before it commits. Under FOR UPDATE the
   * move waits on the message and the message on the move: the engine logs
   * the deadlock and the ticket stays where it was, or the visitor's message
   * is lost.
   */
  it.each([
    ['a ticket that never routed', false],
    ['a ticket held for the router', true],
  ])('both commit, on %s', async (_label, held) => {
    const care = await group('Customer Care');
    const sales = await group('Sales');
    const ticket = await chat(await webchat(care, held), care, held);
    await db.insert(automationRules).values({
      name: 'Chat to sales',
      trigger: 'on_update',
      conditions: { all: [] },
      actions: [{ type: 'assign_group', groupId: sales }],
    });

    const move = pauseBeforeEndHold();
    const commit = holdNextTransaction('after');
    const pass = runAutomations('on_update', ticket.id);
    await move.atPause;

    const visitor = appendVisitorMessage(ticket.contactId, 'Hello? Anybody there?').then(
      () => null,
      (error: unknown) => error,
    );
    await untilWaitingOnALock(db);
    move.release();
    await commit.atHold;
    commit.release();
    await pass;

    expect(await visitor).toBeNull();
    expect(await inbound(ticket.id)).toBe(2);
    expect((await ticketRow(ticket.id)).groupId).toBe(sales);
    if (held) expect(await stage(ticket.id)).toEqual({ stage: 'decided', outcome: 'rule' });
  });
});

// --- Before a write: the router's and the rota's own locks --------------------

describe('a customer’s message, while a routing writer holds the ticket', () => {
  /**
   * Each writer held open after its last statement, with its lock on the
   * ticket: a message inserted then must not wait for it. Under FOR UPDATE it
   * waits until the writer commits, and the second's `lock_timeout` refuses
   * it.
   */
  async function expectInsertGoesThrough(id: string, writer: () => Promise<unknown>, nth = 1) {
    const writing = holdTransaction(nth);
    const running = writer();
    await writing.atHold;
    const refused = await insertWhileHeld(id);
    writing.release();
    await running;
    expect(sqlState(refused)).toBeUndefined();
    expect(refused).toBeNull();
    expect(await inbound(id)).toBe(2);
  }

  async function heldChat() {
    const samir = await agent('Samir');
    const care = await group('Customer Care');
    const sales = await group('Sales', [samir]);
    const ticket = await chat(await webchat(care, true), care, true);
    const [category] = await db.execute(sql`
      update ticket_categories set route_group_id = ${sales} where key = 'sales' returning id`);
    return { ticket, sales, samir, category: (category as { id: string }).id };
  }

  it('beginRouting', async () => {
    const care = await group('Customer Care');
    const ticket = await chat(await webchat(care, true), care, true);

    await expectInsertGoesThrough(ticket.id, () => beginRouting(ticket.id));
  });

  it('the router’s phase one', async () => {
    const t = await heldChat();
    await setConversationCategory(t.ticket.id, t.category, { label: 'jev:category' });

    await expectInsertGoesThrough(t.ticket.id, () =>
      routeNow(t.ticket.id, { label: 'jev:category' }),
    );

    expect((await ticketRow(t.ticket.id)).groupId).toBe(t.sales);
  });

  it('the router’s phase three', async () => {
    const t = await heldChat();
    await setConversationCategory(t.ticket.id, t.category, { label: 'jev:category' });

    // No rules, so phase two opens no transaction: the second is phase three.
    await expectInsertGoesThrough(
      t.ticket.id,
      () => routeNow(t.ticket.id, { label: 'jev:category' }),
      2,
    );

    expect(await ticketRow(t.ticket.id)).toMatchObject({
      groupId: t.sales,
      assigneeAgentId: t.samir,
    });
  });

  it('assignConversation’s pick', async () => {
    const hana = await agent('Hana');
    const care = await group('Customer Care', [hana]);
    const ticket = await chat(await webchat(care, false), care, false);

    await expectInsertGoesThrough(ticket.id, () => assignConversation(ticket.id));

    expect((await ticketRow(ticket.id)).assigneeAgentId).toBe(hana);
  });
});
