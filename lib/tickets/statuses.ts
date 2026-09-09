import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketStatuses } from '@/db/schema';

/**
 * The status a ticket opens in — and the one a resolved ticket returns to when
 * the customer writes again.
 *
 * Two lookups rather than one, and the second is the point: an admin can clear
 * `is_default` on every row from the statuses screen, and a single query would
 * then return null and stop mail being filed at all. Falling back to the
 * lowest-positioned open status means a misconfigured default costs the team a
 * ticket in the wrong column, not a message that never became a ticket.
 *
 * Takes the transaction handle rather than reaching for `db` itself, because
 * every caller resolves this inside the same transaction that inserts the
 * conversation — reading outside it would let a status deleted mid-flight pass
 * the foreign key check and fail the insert.
 *
 * One copy on purpose. This lived privately in all five ingest paths — email,
 * WhatsApp, Meta, the widget and the portal — where it had already drifted into
 * two spellings, which is the shape of the bug `send_csat` shipped by keeping
 * private copies of `automatedReplyBlocked` and `carrierFor`. A new channel
 * imports this rather than writing a sixth.
 */
export async function defaultOpenStatusId(tx: typeof db): Promise<string | null> {
  const preferred = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.category, 'open'), eq(ticketStatuses.isDefault, true)))
    .limit(1);

  if (preferred[0]) return preferred[0].id;

  const fallback = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, 'open'))
    .orderBy(ticketStatuses.position)
    .limit(1);

  return fallback[0]?.id ?? null;
}
