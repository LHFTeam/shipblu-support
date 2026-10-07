import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { internalRecipients, locations, sideConversations } from '@/db/schema';

/**
 * The side-conversation picker's two registers, and the lock that keeps a
 * thread being started and an entry being deleted from passing each other.
 *
 * Both are pointed at from `side_conversations` by an `ON DELETE SET NULL`
 * foreign key, so they need the same two halves of one protocol, and it lives
 * here once rather than as a copy per register: a fix made to one copy and not
 * the other is how two registers that look alike stop behaving alike.
 */
const REGISTERS = {
  location: { table: locations, threads: sideConversations.locationId },
  recipient: { table: internalRecipients, threads: sideConversations.recipientId },
} as const;

export type Register = keyof typeof REGISTERS;

type Entry<R extends Register> = (typeof REGISTERS)[R]['table']['$inferSelect'];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Removal<R extends Register> =
  /** No thread had gone to it, so the row is gone. */
  | { outcome: 'deleted' }
  /**
   * A thread had, so it was switched off instead. `entry` is the row as it was
   * found, so `entry.isActive` says whether it was already off — the sentence
   * the admin reads differs.
   */
  | { outcome: 'retired'; entry: Entry<R>; threads: number }
  /** No such row: deleted by somebody else, or never there. */
  | { outcome: 'gone' };

/**
 * Deletes an entry nothing has been sent to, and retires one something has.
 *
 * An unguarded delete succeeds and says nothing while it blanks who was asked
 * on every thread sent to the entry: the card falls back to the bare address in
 * `to_addresses`, and grouping or reporting by location silently loses those
 * threads. So an entry a thread has used is marked inactive instead — gone from
 * the picker, still named on the threads. That is the answer `deleteSlaPolicy`
 * gives a policy tickets point at. Groups and statuses refuse instead and ask
 * for their tickets to be moved first, but a thread already sent to a hub cannot
 * be moved to another one, so a refusal would leave the admin with nothing they
 * could do.
 *
 * One transaction, and the row is locked `for update` before the threads are
 * counted. Counted without the lock, a thread started in between committed, the
 * delete landed after it, and the new thread lost its hub — the very thing the
 * count is there to prevent; measured with two sessions. The lock conflicts with
 * the share lock `holdEntry` takes for a thread being started, which either
 * commits first and is counted, or waits and then finds the entry gone.
 */
export async function removeEntry<R extends Register>(
  register: R,
  id: string,
): Promise<Removal<R>> {
  const { table, threads: column } = REGISTERS[register];

  return db.transaction(async (tx) => {
    const [entry] = await tx.select().from(table).where(eq(table.id, id)).for('update');
    if (!entry) return { outcome: 'gone' };

    const [usage] = await tx
      .select({ threads: sql<number>`count(*)::int` })
      .from(sideConversations)
      .where(eq(column, id));
    const threads = usage?.threads ?? 0;

    if (threads > 0) {
      if (entry.isActive) {
        await tx
          .update(table)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(table.id, id));
      }
      return { outcome: 'retired', entry: entry as Entry<R>, threads };
    }

    await tx.delete(table).where(eq(table.id, id));
    return { outcome: 'deleted' };
  });
}

/**
 * Whether a thread may still be started to this entry, answered under a share
 * lock held until `tx` commits — the other half of `removeEntry`'s protocol.
 *
 * `startSideConversation` reads the entry before it does anything else, so it
 * can refuse early and knows the address. That read takes no lock, and the
 * insert comes after the guard checks, so a hub deleted or retired in between
 * was missed: the foreign key refused a deleted one with an exception, which
 * the composer reports as a send that "may or may not have gone through" when
 * nothing was written, and a retired one was sent to anyway.
 *
 * `for share` rather than the `for key share` the foreign key takes, because it
 * also waits for a plain edit: switching a hub off on its own form takes a
 * no-key update lock, which a key-share lock does not wait for. Waiting, it
 * re-reads the row as committed and finds it gone or inactive. Holding it, a
 * delete waits for the thread and then counts it.
 */
export async function holdEntry(tx: Tx, register: Register, id: string): Promise<boolean> {
  const { table } = REGISTERS[register];
  const [entry] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.isActive, true)))
    .for('share');
  return Boolean(entry);
}
