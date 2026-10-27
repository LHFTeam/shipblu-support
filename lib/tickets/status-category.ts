import { sql } from 'drizzle-orm';
import { conversations, ticketStatuses } from '@/db/schema';
import type { StatusCategory } from '@/lib/tickets/vocabulary';

/**
 * A ticket's status category, as a column of a read of `conversations` that
 * locks the ticket's row.
 *
 * A subquery rather than a join, because of the lock. Under READ COMMITTED a
 * locked read that waits on another writer re-checks the row it waited for —
 * newest version — against the joined rows it read before waiting. A writer
 * that moved the ticket to another status fails that join, and the read
 * answers no row: the ticket reads as gone while it is there. A subquery is
 * evaluated again against the row as it now is.
 */
export function statusCategoryOf() {
  return sql<StatusCategory>`(select ${ticketStatuses.category} from ${ticketStatuses} where ${ticketStatuses.id} = ${conversations.statusId})`;
}
