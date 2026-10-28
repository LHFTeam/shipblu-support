import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { conversations } from '@/db/schema';
import { ROUTING_GRACE_MS } from './hold';

/**
 * The hold as a query asks it — the SQL twin of `isHeld` (`./hold`), for a
 * reader that counts held tickets rather than holding a row: the live board's
 * "being routed" (`queueSnapshot`), where a held ticket is unassigned by design
 * and the Unassigned tile would otherwise call it work nobody has picked up.
 *
 * Its own module rather than a line beside `isHeld`, because `hold.ts` is
 * client-safe — the inbox draws "Routing…" from it in the browser — and this
 * imports the schema, which the client-import check refuses in a browser
 * bundle. `held-sql.db.test.ts` holds the two to one answer on the same rows.
 *
 * Like `isHeld`, it reads the hold's own columns and nothing about whether the
 * ticket is still work: a ticket resolved inside its window keeps the window on
 * its row until `settle_routing` records `not_open`. So a count is taken over a
 * population that already asks that — the open backlog, which is `routingHold`'s
 * `isWorkable` (open or pending, not spam, merged or deleted) less the bot,
 * which never routes — and then agrees with the inbox's badge too.
 *
 * `now` is bound as an ISO string behind `::timestamptz`, never as a Date: a
 * Date in a `sql` template reaches postgres.js as an untyped parameter it cannot
 * serialise. The grace is built from `ROUTING_GRACE_MS` rather than retyped, so
 * the valve's length is stated once; and the comparison is written the way
 * `isHeld` writes it — now before the window's end plus the grace — so the two
 * read as the same sentence.
 */
export function heldSql(now: Date): SQL {
  return sql`(${conversations.routingWindowEndsAt} is not null
    and ${conversations.routingDecidedAt} is null
    and ${conversations.assigneeAgentId} is null
    and ${now.toISOString()}::timestamptz
      < ${conversations.routingWindowEndsAt} + make_interval(secs => ${ROUTING_GRACE_MS / 1000}))`;
}
