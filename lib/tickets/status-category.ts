import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversations, ticketStatuses } from '@/db/schema';
import type { StatusCategory } from '@/lib/tickets/vocabulary';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A ticket's status category, as a column of a read of `conversations` that
 * locks the ticket's row. Read the answer through `lockedStatusCategory`.
 *
 * A subquery rather than a join, because of the lock. Under READ COMMITTED a
 * locked read that waits on another writer re-checks the row it waited for —
 * newest version — against the joined rows it read before waiting. A writer
 * that moved the ticket to another status fails that join, and the read
 * answers no row: the ticket reads as gone while it is there. A subquery is
 * evaluated again against the row as it now is.
 *
 * Against the row as it is, but still in the snapshot the read began with: a
 * status created after it, and given to the ticket while the read waited, is
 * not there to find, and the subquery answers null.
 */
export function statusCategoryOf() {
  return sql<StatusCategory | null>`(select ${ticketStatuses.category} from ${ticketStatuses} where ${ticketStatuses.id} = ${conversations.statusId})`;
}

/**
 * The category `statusCategoryOf` answered, or, where it answered none, the
 * status read again by its id. The second statement takes a snapshot of its
 * own, which holds the status the ticket now names: the foreign key means it
 * exists, so it is not null there. Without it, a pending ticket moved to a
 * status an admin had just added would read as resolved or closed.
 */
export async function lockedStatusCategory(
  executor: Executor,
  row: { statusId: string; statusCategory: StatusCategory | null },
): Promise<StatusCategory> {
  if (row.statusCategory !== null) return row.statusCategory;
  const [status] = await executor
    .select({ category: ticketStatuses.category })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.id, row.statusId))
    .limit(1);
  if (!status) throw new Error(`ticket status ${row.statusId} not found`);
  return status.category;
}
