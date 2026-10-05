import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { locations, sideConversations } from '@/db/schema';

export type LocationRemoval =
  /** Nothing pointed at it, so the row is gone. */
  | { outcome: 'deleted' }
  /**
   * A side conversation went to it, so it was switched off instead — or was
   * already off, which `wasActive` tells apart for the sentence the admin reads.
   */
  | { outcome: 'retired'; name: string; code: string; threads: number; wasActive: boolean }
  /** No such row: deleted by somebody else, or never there. */
  | { outcome: 'gone' };

/**
 * Deletes a location nothing has been sent to, and retires one something has.
 *
 * `side_conversations.location_id` is `ON DELETE SET NULL`, so an unguarded
 * delete succeeds and says nothing while it strips the hub off every thread
 * that asked it — the card falls back to the bare address in `to_addresses`,
 * and grouping or reporting by location silently loses those threads. So a
 * location a thread has used is marked not operating instead: gone from the
 * picker, still named on the threads. That is the rule every settings screen
 * follows for a row something points at (`settings-shared.ts`), and the one
 * `deleteInternalRecipient` applies to the picker's other register.
 *
 * One transaction, and the location row is locked before the threads are
 * counted. Starting a thread takes a key-share lock on it through the foreign
 * key, which `for update` conflicts with: a thread being started as the admin
 * presses Delete either commits first and is counted, or waits and is then
 * refused by the foreign key because the hub is gone. Counting without the lock
 * would leave a window in which the delete lands after the count and nulls the
 * new thread's hub — the very thing the count is there to prevent.
 */
export async function removeLocation(id: string): Promise<LocationRemoval> {
  return db.transaction(async (tx) => {
    const [place] = await tx
      .select({ name: locations.name, code: locations.code, isActive: locations.isActive })
      .from(locations)
      .where(eq(locations.id, id))
      .for('update');

    if (!place) return { outcome: 'gone' };

    const [usage] = await tx
      .select({ threads: sql<number>`count(*)::int` })
      .from(sideConversations)
      .where(eq(sideConversations.locationId, id));

    const threads = usage?.threads ?? 0;

    if (threads > 0) {
      if (place.isActive) {
        await tx
          .update(locations)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(locations.id, id));
      }

      return {
        outcome: 'retired',
        name: place.name,
        code: place.code,
        threads,
        wasActive: place.isActive,
      };
    }

    await tx.delete(locations).where(eq(locations.id, id));
    return { outcome: 'deleted' };
  });
}
