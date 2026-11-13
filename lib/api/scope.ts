import { and, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { apiTickets, conversations } from '@/db/schema';
import type { Caller } from './sessions';

/** The columns of `conversations`, or of an alias of it, that the predicate reads. */
type TicketColumns = Record<
  'id' | 'requesterContactId' | 'channel' | 'deletedAt' | 'isSpam' | 'mergedIntoId',
  AnyPgColumn
>;

/**
 * Which tickets the myBlu app may read and write, as one predicate
 * (`plans/myblu-ticket-api.md`, _What the app can read_). Every statement the
 * API runs about a ticket carries it, in the same `WHERE` as the ticket's id:
 * looking the ticket up first and comparing afterwards is the same bug written
 * more slowly (`lib/portal/tickets.ts`).
 *
 * Built here and nowhere else, and taking the caller as a required argument,
 * as `readableByRole(role)` takes its role: there is no form of it that
 * forgets who is asking, so a new read cannot leave it out and still compile.
 * Not lifted from the portal's queries, whose `getTicket` and `appendReply`
 * carry no `merged_into_id` filter.
 *
 * Each half closes what the others leave open:
 *
 * - **The ownership row, by the session's identity.** What a contact cannot
 *   give: a merge re-points identities, two identities can land on one
 *   contact, and a backend can vouch for a wrong phone. Each changes what an
 *   agent sees, and with this row none of them changes what another app user
 *   reads. The row is immutable (`api_tickets`), so it is safe under a lock:
 *   nothing changes the columns it is joined on.
 * - **`requester_contact_id`, the session's contact**, read through the
 *   identity on this request: a contact merge moves it with the identity, and
 *   nothing else writes it on this channel.
 * - **`channel = 'api'`**, which keeps the WhatsApp history the phone join put
 *   on the same contact out of the app.
 * - **Not deleted, not spam, not merged away.** A ticket the team took out of
 *   the queue is out of the app too; a merged one lives on in its survivor,
 *   which the app does not own.
 *
 * Not yours, not there, deleted, merged and not on `api` are therefore one
 * `404` from one query, and nothing can be learned by asking which.
 *
 * `table` is `conversations` itself, or an alias of it for a statement that
 * reads the tickets a second time inside a read of one (`unreadTotalSql`).
 */
export function ownedTicket(caller: Caller, table: TicketColumns = conversations): SQL {
  return and(
    exists(
      db
        .select({ one: sql`1` })
        .from(apiTickets)
        .where(
          and(
            eq(apiTickets.conversationId, table.id),
            eq(apiTickets.identityId, caller.identityId),
          ),
        ),
    ),
    eq(table.requesterContactId, caller.contactId),
    eq(table.channel, 'api'),
    isNull(table.deletedAt),
    eq(table.isSpam, false),
    isNull(table.mergedIntoId),
  )!;
}
