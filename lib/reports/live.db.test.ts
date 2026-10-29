import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  contacts,
  conversations,
  messages,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { ROUTING_GRACE_MS } from '@/lib/routing/hold';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { agentLoad, backlogCuts, queueSnapshot, todayByHour } from './live';

/**
 * The live report's hourly volume, the one figure on it counted from messages
 * rather than tickets — so the one that has to say for itself which rows are
 * traffic. The board of who is carrying what, the one table on it keyed on two
 * different people per ticket. And the open work by category, a third cut of
 * the backlog the queue and the channel table already count, which has to add
 * up to the same totals.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';
const NOW = DateTime.fromISO('2026-10-13T12:30', { zone: ZONE });

async function ticket(
  channel: 'whatsapp' | 'email' | 'whatsapp_bot',
  values: Partial<typeof conversations.$inferInsert> & { status?: string } = {},
): Promise<string> {
  const { status = 'Open', ...rest } = values;
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, status));
  const [inserted] = await db
    .insert(conversations)
    .values({ channel, statusId: row!.id, requesterContactId: contact!.id, ...rest })
    .returning({ id: conversations.id });
  return inserted!.id;
}

describe('todayByHour', () => {
  it('counts what was said, from either side, and neither side’s reactions', async () => {
    const chat = await ticket('whatsapp');
    const mail = await ticket('email');
    const at = (time: string) => DateTime.fromISO(`2026-10-13T${time}`, { zone: ZONE }).toJSDate();

    await db.insert(messages).values([
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: at('11:05'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: 'On its way',
        meta: { sendKind: 'text' },
        createdAt: at('11:10'),
      },
      {
        conversationId: chat,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: at('11:12'),
      },
      {
        conversationId: chat,
        direction: 'outbound',
        bodyText: '[reacted ❤️]',
        meta: { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
        createdAt: at('11:15'),
      },
      // No `whatsappType` at all, as on every email: still traffic.
      { conversationId: mail, direction: 'inbound', bodyText: 'Refund?', createdAt: at('11:20') },
    ]);

    const hours = await todayByHour(ZONE, NOW.toJSDate());

    expect(hours.find((bucket) => bucket.hour === 11)).toEqual({
      hour: 11,
      inbound: 2,
      outbound: 1,
    });
  });
});

describe('agentLoad', () => {
  // The board's Breached column must name the person tomorrow's report files
  // the breach under, while Open and Waiting on us stay the capacity check's
  // count of what each person holds.
  it('counts a breach against the number’s owner and the work against whoever holds it', async () => {
    const [nayera, bob] = await db
      .insert(agents)
      .values([
        { name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' },
        { name: 'Bob', email: 'bob@shipblu.test', role: 'agent' },
      ])
      .returning({ id: agents.id });
    const waiting = { lastCustomerMessageAt: NOW.minus({ hours: 2 }).toJSDate() };

    // Nayera's number, Bob working it, past its first-response target and
    // waiting on a reply.
    await ticket('whatsapp', {
      accountableAgentId: nayera!.id,
      assigneeAgentId: bob!.id,
      firstResponseBreached: true,
      ...waiting,
    });
    // Nayera's number, nobody holding it, past its resolution target.
    await ticket('whatsapp', { accountableAgentId: nayera!.id, resolutionBreached: true });
    // Bob's own, on a team number: his breach, as before owners existed.
    await ticket('email', { assigneeAgentId: bob!.id, firstResponseBreached: true });
    // Bob's and on time.
    await ticket('email', { assigneeAgentId: bob!.id });
    // Nayera's, breached and resolved since: out of the live backlog altogether.
    await ticket('whatsapp', {
      accountableAgentId: nayera!.id,
      assigneeAgentId: nayera!.id,
      firstResponseBreached: true,
      status: 'Resolved',
    });

    const load = await agentLoad();
    const row = (id: string) => load.find((agent) => agent.id === id);

    expect(row(nayera!.id)).toMatchObject({
      open: 0,
      awaitingReply: 0,
      breached: 2,
      oldestWaitingSince: null,
    });
    expect(row(bob!.id)).toMatchObject({
      open: 3,
      awaitingReply: 1,
      breached: 1,
      oldestWaitingSince: waiting.lastCustomerMessageAt,
    });
  });
});

/** The same instant as `NOW`, as the queries take it. */
const INSTANT = cairo('2026-10-13T12:30');
const MINUTE = 60_000;

/** The starter categories the seed writes, by key, in the registry's own order. */
const SEEDED = ['sales', 'customer_support', 'merchant_support', 'courier_jobs'] as const;

async function categoryIds(): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: ticketCategories.id, key: ticketCategories.key })
    .from(ticketCategories);
  return Object.fromEntries(rows.map((row) => [row.key, row.id]));
}

/** The table's rows by key, `null` for the no-category row. */
async function loadByKey() {
  const ids = await categoryIds();
  const keyOf = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
  const load = (await backlogCuts()).categories;
  return {
    keys: load.map((row) => (row.categoryId === null ? null : keyOf.get(row.categoryId))),
    row: (key: string | null) =>
      load.find((row) => row.categoryId === (key === null ? null : ids[key])),
  };
}

describe('backlogCuts', () => {
  it('lists every active category at zero, in the registry’s order, and No category last', async () => {
    const ids = await categoryIds();

    expect((await backlogCuts()).categories).toEqual([
      ...SEEDED.map((key) => ({
        categoryId: ids[key],
        labelEn: expect.any(String),
        isActive: true,
        open: 0,
        awaitingReply: 0,
      })),
      { categoryId: null, labelEn: null, isActive: true, open: 0, awaitingReply: 0 },
    ]);
  });

  it('keeps the registry’s order whatever the counts — position, then key', async () => {
    const ids = await categoryIds();
    // Level with Sales, and ahead of it by key.
    await db
      .update(ticketCategories)
      .set({ position: 0 })
      .where(eq(ticketCategories.key, 'merchant_support'));
    for (let i = 0; i < 3; i += 1) await ticket('email', { categoryId: ids.courier_jobs });
    await ticket('email', { categoryId: ids.sales });

    const { keys, row } = await loadByKey();

    // Courier jobs holds the most and stays where the registry puts it.
    expect(keys).toEqual(['merchant_support', 'sales', 'customer_support', 'courier_jobs', null]);
    expect(row('courier_jobs')).toMatchObject({ open: 3 });
  });

  it('lists a retired category only while it holds open work, after the active ones', async () => {
    const ids = await categoryIds();
    // First in the registry, so "after the active ones" is the retirement's doing.
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.key, 'sales'));

    expect((await loadByKey()).keys).toEqual([
      'customer_support',
      'merchant_support',
      'courier_jobs',
      null,
    ]);

    // Nor does work it no longer holds bring it back.
    await ticket('email', { categoryId: ids.sales, status: 'Resolved' });
    expect((await loadByKey()).keys).not.toContain('sales');

    await ticket('email', { categoryId: ids.sales });
    const { keys, row } = await loadByKey();

    expect(keys).toEqual(['customer_support', 'merchant_support', 'courier_jobs', 'sales', null]);
    expect(row('sales')).toMatchObject({ isActive: false, open: 1 });
  });

  it('counts the open backlog and nothing else', async () => {
    const ids = await categoryIds();
    const sales = ids.sales!;
    const mergedInto = await ticket('email', { status: 'Resolved' });

    await ticket('email', { categoryId: sales }); // the one that counts
    await ticket('email', { categoryId: sales, status: 'Resolved' });
    await ticket('email', { categoryId: sales, status: 'Closed' });
    await ticket('email', { categoryId: sales, isSpam: true });
    await ticket('email', { categoryId: sales, mergedIntoId: mergedInto });
    await ticket('email', { categoryId: sales, deletedAt: INSTANT });
    // The bot's menu is a funnel, not work anybody may answer.
    await ticket('whatsapp_bot', { categoryId: sales });

    const { row } = await loadByKey();

    expect(row('sales')).toMatchObject({ open: 1 });
    // The merge target is resolved, so nothing reaches the uncategorised row either.
    expect(row(null)).toMatchObject({ open: 0 });
  });

  it('counts a pending ticket as open, as the channel table does', async () => {
    const ids = await categoryIds();
    await ticket('whatsapp', { categoryId: ids.customer_support, status: 'Pending' });
    await ticket('whatsapp', { categoryId: ids.customer_support });

    expect((await loadByKey()).row('customer_support')).toMatchObject({ open: 2 });
  });

  it('counts waiting on us by the page’s one definition — the customer spoke last', async () => {
    const ids = await categoryIds();
    const at = (time: string) => cairo(`2026-10-13T${time}`);
    const sales = ids.sales!;

    await ticket('email', { categoryId: sales, lastCustomerMessageAt: at('10:00') });
    await ticket('email', {
      categoryId: sales,
      lastCustomerMessageAt: at('10:00'),
      lastAgentMessageAt: at('09:00'),
    });
    // Answered since.
    await ticket('email', {
      categoryId: sales,
      lastCustomerMessageAt: at('10:00'),
      lastAgentMessageAt: at('10:05'),
    });
    // Nobody has written: open, and waiting on nobody.
    await ticket('email', { categoryId: sales });
    await ticket('whatsapp', { lastCustomerMessageAt: at('11:00') });

    const { row } = await loadByKey();

    expect(row('sales')).toMatchObject({ open: 4, awaitingReply: 2 });
    expect(row(null)).toMatchObject({ open: 1, awaitingReply: 1 });
  });

  it('adds up to the same backlog as the channel table and the queue', async () => {
    const ids = await categoryIds();
    const waiting = { lastCustomerMessageAt: cairo('2026-10-13T10:00') };

    await ticket('email', { categoryId: ids.sales, ...waiting });
    await ticket('whatsapp', { categoryId: ids.sales, status: 'Pending' });
    await ticket('whatsapp', { categoryId: ids.courier_jobs, ...waiting });
    await ticket('email', { ...waiting });
    await ticket('whatsapp', {});
    // Out of all three.
    await ticket('email', { categoryId: ids.sales, status: 'Resolved', ...waiting });
    await ticket('whatsapp_bot', { ...waiting });

    // One statement for the two tables: a ticket arriving between two reads
    // would be in one cut and not the other.
    const [{ categories, channels }, queue] = await Promise.all([
      backlogCuts(),
      queueSnapshot(INSTANT),
    ]);
    const sum = (rows: { open: number; awaitingReply: number }[]) => ({
      open: rows.reduce((total, row) => total + row.open, 0),
      awaitingReply: rows.reduce((total, row) => total + row.awaitingReply, 0),
    });

    expect(sum(categories)).toEqual({ open: 5, awaitingReply: 3 });
    expect(sum(channels)).toEqual(sum(categories));
    expect({ open: queue.open + queue.pending, awaitingReply: queue.awaitingReply }).toEqual(
      sum(categories),
    );
  });
});

describe('backlogCuts, its two cuts apart', () => {
  // In the channel set the category is null because it is not grouped on; in
  // the category set null is the tickets nothing has filed. Told apart by
  // `grouping()`, a channel row must never be read as "No category".
  it('tells a channel row from No category, which both read as a null category', async () => {
    const ids = await categoryIds();
    await ticket('email', { categoryId: ids.sales });
    await ticket('whatsapp', { categoryId: ids.courier_jobs });
    await ticket('whatsapp', { categoryId: ids.courier_jobs });

    const { channels, categories } = await backlogCuts();

    expect(channels).toEqual([
      { channel: 'whatsapp', open: 2, awaitingReply: 0 },
      { channel: 'email', open: 1, awaitingReply: 0 },
    ]);
    expect(categories.at(-1)).toEqual({
      categoryId: null,
      labelEn: null,
      isActive: true,
      open: 0,
      awaitingReply: 0,
    });
  });
});

describe('queueSnapshot', () => {
  it('counts the held tickets among the unassigned — the ones the inbox marks routing', async () => {
    const [holder] = await db
      .insert(agents)
      .values({ name: 'Nayera', email: 'nayera@shipblu.test', role: 'agent' })
      .returning({ id: agents.id });
    const at = (offsetMs: number) => new Date(INSTANT.getTime() + offsetMs);

    await ticket('whatsapp', { routingWindowEndsAt: at(3 * MINUTE) });
    await ticket('whatsapp', { routingWindowEndsAt: at(-5 * MINUTE) }); // inside the grace
    await ticket('whatsapp', { routingWindowEndsAt: at(-ROUTING_GRACE_MS - MINUTE) });
    await ticket('whatsapp', {
      routingWindowEndsAt: at(3 * MINUTE),
      routingDecidedAt: at(-MINUTE),
    });
    await ticket('whatsapp', { routingWindowEndsAt: at(3 * MINUTE), assigneeAgentId: holder!.id });
    // Held by its columns and not work: outside the backlog altogether.
    await ticket('whatsapp', { routingWindowEndsAt: at(3 * MINUTE), status: 'Resolved' });
    await ticket('email', {});

    const queue = await queueSnapshot(INSTANT);

    expect(queue).toMatchObject({ open: 6, unassigned: 5, routing: 2 });
  });
});
