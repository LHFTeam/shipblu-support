import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  internalRecipients,
  locations,
  sideConversations,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdEntry, removeEntry, type Register } from './directory';

/**
 * The Delete buttons on `/admin/locations` and `/admin/recipients`, and the
 * send that races them. `side_conversations.location_id` and `recipient_id` are
 * both `ON DELETE SET NULL`, so a delete that lands on an entry a thread has
 * used succeeds and blanks who was asked. These pin the three answers for both
 * registers, that the thread keeps its entry in the one that matters, and that
 * a thread being started and a delete wait for each other rather than pass.
 */

withCleanDatabase();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let serial = 0;

/** One entry in each register, built the same way so the two read alike. */
const ADD: Record<Register, (isActive?: boolean) => Promise<string>> = {
  async location(isActive = true) {
    const code = `HUB-${++serial}`;
    const [row] = await db
      .insert(locations)
      .values({ name: `Hub ${code}`, code, email: `${code.toLowerCase()}@shipblu.test`, isActive })
      .returning({ id: locations.id });
    return row!.id;
  },
  async recipient(isActive = true) {
    const name = `Team ${++serial}`;
    const [row] = await db
      .insert(internalRecipients)
      .values({ name, email: `team-${serial}@shipblu.test`, kind: 'team', isActive })
      .returning({ id: internalRecipients.id });
    return row!.id;
  },
};

const TABLE = { location: locations, recipient: internalRecipients } as const;

async function isActive(register: Register, id: string): Promise<boolean | undefined> {
  const table = TABLE[register];
  const [row] = await db.select({ isActive: table.isActive }).from(table).where(eq(table.id, id));
  return row?.isActive;
}

/** A ticket with a side conversation addressed to the entry, through `executor`. */
async function threadTo(
  register: Register,
  id: string,
  executor: Pick<Tx, 'select' | 'insert'> = db,
): Promise<void> {
  const [status] = await executor
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await executor.insert(contacts).values({ name: 'Amira' }).returning();
  const [ticket] = await executor
    .insert(conversations)
    .values({ channel: 'email', statusId: status!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  await executor.insert(sideConversations).values({
    conversationId: ticket!.id,
    subject: '1212121212121 || where is it',
    ...(register === 'location' ? { locationId: id } : { recipientId: id }),
    toAddresses: ['hub@shipblu.test'],
  });
}

/** Resolves once some other session of this database is waiting on a row lock. */
async function somebodyWaits(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('nothing ever waited on the lock');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe.each(['location', 'recipient'] as const)('removeEntry(%s)', (register) => {
  it('deletes an entry no thread has gone to', async () => {
    const id = await ADD[register]();
    await threadTo(register, await ADD[register]());

    expect(await removeEntry(register, id)).toEqual({ outcome: 'deleted' });
    expect(await isActive(register, id)).toBeUndefined();
  });

  it('retires one a thread has gone to, and the thread keeps it', async () => {
    const id = await ADD[register]();
    await threadTo(register, id);
    await threadTo(register, id);

    expect(await removeEntry(register, id)).toMatchObject({
      outcome: 'retired',
      threads: 2,
      entry: { id, isActive: true },
    });
    expect(await isActive(register, id)).toBe(false);

    const column =
      register === 'location' ? sideConversations.locationId : sideConversations.recipientId;
    const kept = await db.select({ id: column }).from(sideConversations).where(eq(column, id));
    expect(kept).toHaveLength(2);
  });

  it('leaves one already inactive as it is, and says it was', async () => {
    const id = await ADD[register](false);
    await threadTo(register, id);

    expect(await removeEntry(register, id)).toMatchObject({
      outcome: 'retired',
      entry: { isActive: false },
    });
    expect(await isActive(register, id)).toBe(false);
  });

  it('answers an entry that is already gone without touching anything', async () => {
    const kept = await ADD[register]();

    expect(await removeEntry(register, '00000000-0000-4000-8000-000000000000')).toEqual({
      outcome: 'gone',
    });
    expect(await isActive(register, kept)).toBe(true);
  });
});

describe.each(['location', 'recipient'] as const)('holdEntry(%s)', (register) => {
  it('answers an open entry yes, and a retired or deleted one no', async () => {
    const open = await ADD[register]();
    const retired = await ADD[register](false);

    await db.transaction(async (tx) => {
      expect(await holdEntry(tx, register, open)).toBe(true);
      expect(await holdEntry(tx, register, retired)).toBe(false);
      expect(await holdEntry(tx, register, '00000000-0000-4000-8000-000000000000')).toBe(false);
    });
  });

  // A thread being started holds the entry; the delete waits for it, then
  // counts it, so the entry is retired rather than deleted under the thread.
  it('makes a delete wait for the thread being started, and count it', async () => {
    const id = await ADD[register]();
    let removal: ReturnType<typeof removeEntry> | undefined;
    let settled = false;

    await db.transaction(async (tx) => {
      expect(await holdEntry(tx, register, id)).toBe(true);

      removal = removeEntry(register, id);
      void removal.then(() => (settled = true));
      await somebodyWaits();

      await threadTo(register, id, tx);
      expect(settled).toBe(false);
    });

    expect(await removal).toMatchObject({ outcome: 'retired', threads: 1 });
    expect(await isActive(register, id)).toBe(false);
  });

  // The other order: the entry changes first, and the send waits and is
  // refused. Switched off by a plain update, which is what the edit form does —
  // the case a `for key share` lock would not wait for.
  const table = TABLE[register];
  it.each([
    ['deleted', (tx: Tx, id: string) => tx.delete(table).where(eq(table.id, id))],
    [
      'switched off',
      (tx: Tx, id: string) => tx.update(table).set({ isActive: false }).where(eq(table.id, id)),
    ],
  ])('waits for an entry being %s, then refuses it', async (_, change) => {
    const id = await ADD[register]();
    const changed = deferred();
    const release = deferred();

    const changing = db.transaction(async (tx) => {
      await change(tx, id);
      changed.resolve();
      await release.promise;
    });

    await changed.promise;
    const answer = db.transaction((tx) => holdEntry(tx, register, id));
    await somebodyWaits();
    release.resolve();
    await changing;

    expect(await answer).toBe(false);
  });
});
