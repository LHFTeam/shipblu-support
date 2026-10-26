import { sql } from 'drizzle-orm';

/**
 * The `created_at` of a `priority_changed` or `category_changed` event, read
 * when the statement runs.
 *
 * Every writer of `conversations.priority` or `conversations.category_id`
 * writes the column and then its event in one transaction, so by the time the
 * event is inserted the update holds the ticket's row lock. Stamped with the
 * column default instead — `now()`, the instant the transaction *began* — two
 * writers on one ticket sort in the order they started, not the order they took
 * the lock: an agent whose change waited on the classifier's lock began first,
 * commits last and keeps the column, and its event still sorts before the
 * classifier's. The timeline then shows the classifier overruling the agent,
 * and the disagreement query in `docs/PROJECT-STATE.md` (an agent's change after
 * the classifier's) misses exactly the overrules it exists to count. The
 * category's ownership rule (`plans/ticket-category-routing.md`, decision 4)
 * reads the same order to decide whether Jev may still set a ticket's category.
 *
 * `clock_timestamp()` read after the lock is taken orders the events the way
 * the column was written, which is the only order a reader can reason from.
 *
 * `createTicket`'s `category_changed` is stamped too, though no second writer
 * can reach a row its own transaction has not committed: one spelling for every
 * category event, so Stage 4's ownership rule reads them all the same way. Its
 * `priority_changed` keeps the column default, the one exception, for the same
 * reason it is harmless — nothing else can have written that ticket's priority
 * yet.
 */
export const CHANGE_STAMP = sql<Date>`clock_timestamp()`;
