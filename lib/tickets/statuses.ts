import { and, asc, desc, eq } from 'drizzle-orm';
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

/**
 * `defaultOpenStatusId` for a caller about to insert a ticket, which cannot go
 * on without one.
 *
 * Only a database with no open status at all gets here — one that was never
 * seeded — because the fallback above accepts any open status. Seven insert
 * paths across the five channels threw the same sentence for that case, each
 * written out by hand; they now share this one, so the instruction it gives
 * cannot drift the way the lookup above once did.
 */
export async function requireDefaultOpenStatusId(tx: typeof db): Promise<string> {
  const statusId = await defaultOpenStatusId(tx);
  if (!statusId) {
    throw new Error('No default open ticket status configured — run `npm run db:seed`');
  }
  return statusId;
}

/**
 * The status a conversation that was already over when it reached us is filed
 * in — a WhatsApp Business app chat copied in after a coexistence onboarding.
 *
 * Resolved, not open: nobody here owes it an answer, and an open import would
 * put six months of finished chats in front of the team. Not closed either: an
 * agent can still write on it (with a template — its window shut long ago).
 * The default resolved status first, then the lowest-positioned one, for the
 * reason `defaultOpenStatusId` gives: an admin clearing a flag must not stop
 * an import. Throws only for a database with no resolved status at all, which
 * was never seeded.
 */
export async function requireResolvedStatusId(tx: typeof db): Promise<string> {
  const [status] = await tx
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, 'resolved'))
    .orderBy(desc(ticketStatuses.isDefault), asc(ticketStatuses.position))
    .limit(1);
  if (!status) {
    throw new Error('No resolved ticket status configured — run `npm run db:seed`');
  }
  return status.id;
}
