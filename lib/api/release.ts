import { asc, eq, inArray } from 'drizzle-orm';
import type { db } from '@/db/client';
import {
  apiTickets,
  conversationEvents,
  conversations,
  type ApiSessionEndReason,
} from '@/db/schema';
import { onStatusChanged } from '@/lib/sla';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { resolveStamp } from '@/lib/tickets/resolve-stamp';
import { statusCategoryOf } from '@/lib/tickets/status-category';
import { requireResolvedStatus } from '@/lib/tickets/statuses';
import { reopenWithOwner } from '@/lib/whatsapp/number-owner';

type Tx = typeof db;

/** The revoke reasons after which the account's tickets leave the app. */
export type ReleaseReason = Extract<ApiSessionEndReason, 'account_deleted' | 'number_released'>;

export function releasesTickets(reason: ApiSessionEndReason): reason is ReleaseReason {
  return reason === 'account_deleted' || reason === 'number_released';
}

/** What a release did, and what it owes the SLA once its transaction commits. */
export type Released = {
  /** Every ticket that left the app. */
  count: number;
  /** The tickets it resolved, whose clocks stop after the commit (`afterRelease`). */
  resolved: string[];
  stopsSlaClock: boolean;
};

/**
 * Takes one identity's tickets out of the app, in the revoke's transaction and
 * behind the account's lock (`revokeSessions`), and says so on each.
 *
 * The person behind the account has gone, or the number is somebody else's
 * now, and nobody can read a reply on these tickets any more: `api` has no
 * carrier (`carrierFor`), so an agent's answer was stored as delivered and
 * read by nobody, while the clocks counted a reply the team could never give.
 * So, by the owner's decision on #532:
 *
 * - every ticket gets a `released_from_app` event naming the reason, which the
 *   ticket's header reads, so an agent opening one learns the app cannot show
 *   it before writing into it;
 * - an open or pending one is resolved by the system — a `status_changed`
 *   credited to `myblu`, `via: 'released_from_app'`, and nobody's
 *   `resolved_by_agent_id` — which takes it out of every queue, and its clocks
 *   stop once this commits. No survey: there is nobody to ask, and
 *   `afterTicketResolved` is not called. Nor an `on_update` pass, whose rules
 *   would answer somebody who is not there. A ticket deleted, marked spam or
 *   merged is somebody's tidying already and keeps its status;
 * - then the ownership rows go, as before, so every read through `ownedTicket`
 *   answers `404` from now on and the tickets stay on the contact.
 *
 * The tickets are locked `FOR NO KEY UPDATE` in one statement, in id order,
 * after the account's lock: the order a reply takes them in (the account, then
 * its ticket), so the two cannot wait on each other. A reply already holding a
 * ticket commits first and its message is what the release then resolves; one
 * that comes after finds its session revoked under the account's lock and
 * writes nothing. The status is read through `statusCategoryOf`, never a join,
 * under the lock (AGENTS.md, _A read that locks a row…_).
 */
export async function releaseTickets(
  tx: Tx,
  identityId: string,
  reason: ReleaseReason,
): Promise<Released> {
  const owned = await tx
    .select({ id: apiTickets.conversationId })
    .from(apiTickets)
    .where(eq(apiTickets.identityId, identityId));
  if (owned.length === 0) return { count: 0, resolved: [], stopsSlaClock: false };

  const tickets = await tx
    .select({
      id: conversations.id,
      category: statusCategoryOf(),
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
    })
    .from(conversations)
    .where(
      inArray(
        conversations.id,
        owned.map((row) => row.id),
      ),
    )
    .orderBy(asc(conversations.id))
    .for('no key update');

  const working = tickets.filter(
    (ticket) =>
      (ticket.category === 'open' || ticket.category === 'pending') &&
      !ticket.deletedAt &&
      !ticket.isSpam &&
      !ticket.mergedIntoId,
  );
  const status = working.length > 0 ? await requireResolvedStatus(tx) : null;

  if (tickets.length > 0) {
    await tx.insert(conversationEvents).values(
      tickets.map((ticket) => ({
        conversationId: ticket.id,
        type: 'released_from_app',
        actorLabel: 'myblu',
        createdAt: CHANGE_STAMP,
        data: { reason },
      })),
    );
  }

  for (const ticket of status ? working : []) {
    // Through `reopenWithOwner`, as every status writer goes; a move into
    // resolved realigns nothing, so it only writes.
    await reopenWithOwner(tx, ticket.id, 'resolved', 'reopened_by_status', async () => {
      await tx
        .update(conversations)
        .set({ statusId: status!.id, ...resolveStamp('resolved'), closedAt: null })
        .where(eq(conversations.id, ticket.id));
      await tx.insert(conversationEvents).values({
        conversationId: ticket.id,
        type: 'status_changed',
        actorLabel: 'myblu',
        createdAt: CHANGE_STAMP,
        data: { to: status!.name, category: 'resolved', via: 'released_from_app' },
      });
      return true;
    });
  }

  await tx.delete(apiTickets).where(eq(apiTickets.identityId, identityId));
  return {
    count: owned.length,
    resolved: status ? working.map((ticket) => ticket.id) : [],
    stopsSlaClock: status?.stopsSlaClock ?? false,
  };
}

/**
 * What a release owes once it has committed: the resolved tickets' clocks,
 * paused as a status change pauses them (`onStatusChanged`, best-effort and
 * under each ticket's lock), one ticket at a time.
 */
export async function afterRelease(released: Released): Promise<void> {
  for (const id of released.resolved) await onStatusChanged(id, released.stopsSlaClock);
}
