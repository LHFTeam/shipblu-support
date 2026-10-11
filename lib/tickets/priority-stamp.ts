import { sql } from 'drizzle-orm';

/**
 * The `created_at` of a `priority_changed` event, read when the statement runs.
 *
 * Every writer of `conversations.priority` writes the column and then this
 * event in one transaction, so by the time the event is inserted the update
 * holds the ticket's row lock. Stamped with the column default instead — `now()`,
 * the instant the transaction *began* — two writers on one ticket sort in the
 * order they started, not the order they took the lock: an agent whose change
 * waited on the classifier's lock began first, commits last and keeps the
 * column, and its event still sorts before the classifier's. The timeline then
 * shows the classifier overruling the agent, and the disagreement query in
 * `docs/PROJECT-STATE.md` (an agent's change after the classifier's) misses
 * exactly the overrules it exists to count.
 *
 * `clock_timestamp()` read after the lock is taken orders the events the way
 * the column was written, which is the only order a reader can reason from.
 */
export const PRIORITY_STAMP = sql<Date>`clock_timestamp()`;
