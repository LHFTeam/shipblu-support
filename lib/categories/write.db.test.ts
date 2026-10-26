import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationEvents,
  conversations,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { createTicket } from '@/lib/portal/tickets';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { setCategoryActive } from './admin';
import { setConversationCategory } from './write';

/**
 * The two category writers against real Postgres: the share lock `holdCategory`
 * takes on the registry row, and the spelling of the id they store.
 *
 * The lock is a race, so run one after the other these pass whatever the code
 * does — and they pass afterwards too, since a retire that did not wait lands
 * on the same rows a moment earlier. So each holds a writer open, with every
 * lock it took, while an admin retires the category, and reads what the
 * database looks like at that moment rather than only once both are done. Every
 * test starts from the baseline's four active starter categories.
 */

withCleanDatabase();

const AUTOMATION = { label: 'automation:test' };

/** One of the four categories the baseline seeds, by its key. */
async function categoryId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, key));
  if (!row) throw new Error(`no category ${key}`);
  return row.id;
}

async function customer(): Promise<string> {
  const [row] = await db.insert(contacts).values({ name: 'Amira' }).returning({ id: contacts.id });
  if (!row) throw new Error('contact not inserted');
  return row.id;
}

/** An open ticket with no category, as a channel files one. */
async function ticket(): Promise<string> {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ requesterContactId: await customer(), statusId: status!.id, channel: 'whatsapp' })
    .returning({ id: conversations.id });
  return row!.id;
}

async function carried(conversationId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ categoryId: conversations.categoryId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row?.categoryId;
}

async function categoryEvents(conversationId: string) {
  return db
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'category_changed'),
      ),
    );
}

async function isActive(id: string): Promise<boolean | undefined> {
  const [row] = await db
    .select({ isActive: ticketCategories.isActive })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id));
  return row?.isActive;
}

/**
 * The retire, caught waiting — by its own statement, so a wait on some other
 * row cannot pass for it — and whether it has landed yet. Read while the writer
 * is held, because after the release both orders end in the same rows.
 */
async function whileTheWriterIsHeld(categoryId: string) {
  const [{ waiting }] = (await db.execute(
    sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like 'update "ticket_categories"%'`,
  )) as unknown as [{ waiting: number }];
  return { retiresWaiting: waiting, categoryActive: await isActive(categoryId) };
}

/**
 * A retire is a plain update of `is_active`, and the foreign key from
 * `conversations.category_id` takes only a key-share lock, which such an update
 * does not wait for. Without the share lock a retire would commit between the
 * writer's check that the category is live and its commit, and a ticket would
 * be filed under a category retired before it existed.
 */
describe('a retire while a category is being written', () => {
  it('waits for the ticket createTicket is opening with it, which keeps it and its event', async () => {
    const sales = await categoryId('sales');
    const contactId = await customer();
    const hold = holdNextTransaction('after');
    const creating = createTicket(contactId, {
      subject: 'Prices',
      body: 'How much for 100 parcels a month?',
      category: { id: sales, chosenBy: { label: 'form:sales' } },
    });
    await hold.atHold;

    const retiring = setCategoryActive(sales, false);
    await untilWaitingOnALock(db);
    const held = await whileTheWriterIsHeld(sales);
    hold.release();

    expect(held).toEqual({ retiresWaiting: 1, categoryActive: true });
    await expect(retiring).resolves.toBeNull();
    const { conversationId } = await creating;
    expect(await carried(conversationId)).toBe(sales);
    expect(await categoryEvents(conversationId)).toEqual([
      { data: { from: null, to: sales, key: 'sales', label: 'Sales' } },
    ]);
    expect(await isActive(sales)).toBe(false);
  });

  it('waits for setConversationCategory giving a ticket it, which keeps it and its event', async () => {
    const sales = await categoryId('sales');
    const id = await ticket();
    const hold = holdNextTransaction('after');
    const setting = setConversationCategory(id, sales, AUTOMATION);
    await hold.atHold;

    const retiring = setCategoryActive(sales, false);
    await untilWaitingOnALock(db);
    const held = await whileTheWriterIsHeld(sales);
    hold.release();

    expect(held).toEqual({ retiresWaiting: 1, categoryActive: true });
    await expect(setting).resolves.toEqual({ outcome: 'changed', from: null, to: sales });
    await expect(retiring).resolves.toBeNull();
    expect(await carried(id)).toBe(sales);
    expect(await categoryEvents(id)).toEqual([
      { data: { from: null, to: sales, key: 'sales', label: 'Sales' } },
    ]);
    expect(await isActive(sales)).toBe(false);
  });
});

/**
 * Postgres reads an id in capitals as the same uuid and stores the column
 * lower-case whatever it was handed, but `data.to` is jsonb, kept as written.
 * From Stage 4 Jev's ownership rule reads the event against the column, so the
 * two must spell the id alike — and the unchanged check, done in JavaScript,
 * must not mistake the same category for a change.
 */
describe('setConversationCategory, given an id in capitals', () => {
  it('writes the column and the event in the column’s spelling', async () => {
    const sales = await categoryId('sales');
    const id = await ticket();

    await expect(setConversationCategory(id, sales.toUpperCase(), AUTOMATION)).resolves.toEqual({
      outcome: 'changed',
      from: null,
      to: sales,
    });

    const stored = await carried(id);
    expect(stored).toBe(sales);
    expect(await categoryEvents(id)).toEqual([
      { data: { from: null, to: stored, key: 'sales', label: 'Sales' } },
    ]);
  });

  // A time rule naming the category in capitals would otherwise write an event
  // every fifteen minutes, each naming the category the ticket already had.
  it('reads what the ticket already carries as nothing to write', async () => {
    const sales = await categoryId('sales');
    const id = await ticket();
    await setConversationCategory(id, sales, AUTOMATION);

    await expect(setConversationCategory(id, sales.toUpperCase(), AUTOMATION)).resolves.toEqual({
      outcome: 'unchanged',
    });

    expect(await carried(id)).toBe(sales);
    expect(await categoryEvents(id)).toHaveLength(1);
  });

  // Postgres answers a malformed uuid with 22P02, which would throw out of the
  // console's action with no state rather than the sidebar's sentence.
  it('answers a value that is not a uuid as an unknown category, writing nothing', async () => {
    const id = await ticket();

    await expect(setConversationCategory(id, 'not-a-uuid', AUTOMATION)).resolves.toEqual({
      outcome: 'unknown_category',
    });

    expect(await carried(id)).toBeNull();
    expect(await categoryEvents(id)).toEqual([]);
  });
});
