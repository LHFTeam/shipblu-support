import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { internalRecipients, sideConversations } from '@/db/schema';

export type RecipientRemoval =
  /** No thread had gone to it, so the row is gone. */
  | { outcome: 'deleted' }
  /** A thread had, so it was switched off instead (or already was). */
  | { outcome: 'retired' }
  /** No such row: deleted by somebody else, or never there. */
  | { outcome: 'gone' };

/**
 * Deletes an internal recipient no side conversation has gone to, and retires
 * one something has — the twin of `removeLocation` for the picker's other
 * register, for the same reason: `side_conversations.recipient_id` is
 * `ON DELETE SET NULL`, so a delete that lands on a used row succeeds silently
 * and blanks who was asked on every thread sent to it.
 *
 * The check was always there; what it lacked was the lock. Checked and then
 * deleted as two statements, a thread started in between committed, the delete
 * landed after it, and the new thread lost its recipient — the race
 * `removeLocation`'s comment describes, measured there with two sessions. The
 * row is locked first, so a thread being started either commits before the
 * check and is seen, or waits and is then refused by the foreign key.
 */
export async function removeInternalRecipient(id: string): Promise<RecipientRemoval> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ isActive: internalRecipients.isActive })
      .from(internalRecipients)
      .where(eq(internalRecipients.id, id))
      .for('update');

    if (!row) return { outcome: 'gone' };

    const used = await tx
      .select({ id: sideConversations.id })
      .from(sideConversations)
      .where(eq(sideConversations.recipientId, id))
      .limit(1);

    if (used.length > 0) {
      if (row.isActive) {
        await tx
          .update(internalRecipients)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(internalRecipients.id, id));
      }
      return { outcome: 'retired' };
    }

    await tx.delete(internalRecipients).where(eq(internalRecipients.id, id));
    return { outcome: 'deleted' };
  });
}
