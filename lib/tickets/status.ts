import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, type ticketStatuses } from '@/db/schema';
import { clockInputsIfInFlight, deferToRouter } from '@/lib/routing/state';
import { onStatusChanged, onStatusChangedIn } from '@/lib/sla';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { afterTicketResolved } from '@/lib/tickets/lifecycle';
import { reopenWithOwner } from '@/lib/whatsapp/number-owner';
import { resolveStamp } from './resolve-stamp';

/** The status a ticket is moving to, as read from `ticket_statuses`. */
export type StatusTarget = Pick<
  typeof ticketStatuses.$inferSelect,
  'id' | 'name' | 'category' | 'stopsSlaClock'
>;

/**
 * An agent moves a ticket to a status: the write, the timeline event, the SLA
 * clocks and the resolve hook.
 *
 * One copy for both console paths — the status picker and "reply and resolve"
 * — so the stamps a status writes cannot differ by which button set it. What
 * each path checks first (the `ticket.close` permission, required fields, a
 * root cause) stays with its caller, because the two refuse different things.
 *
 * `via` names the path on the event when it is not the picker, so the timeline
 * can say the status moved as part of a reply.
 *
 * `deferToRouter`, which only the picker passes, hands the caller's own
 * `on_update` pass to the router when the move lands on a decision in flight
 * (`lib/routing/state.ts`), and the answer is whether it did: the caller then
 * runs no pass of its own, and the clocks pause or resume in the move's own
 * transaction, ahead of the router's pass (`onStatusChangedIn`), as they do
 * ahead of the caller's own — or after its commit, where the policies and the
 * hours were not read beforehand (`clockInputsIfInFlight` says when, and what
 * it costs). Only for a move that leaves the ticket in somebody's queue, which
 * `deferToRouter` decides for every writer: the router gives its pass up on a
 * ticket nobody may work, so handed a resolve, it would find the ticket
 * resolved and run nothing, and no rule keyed on the resolve would ever run. A
 * resolve's own pass races nothing either, since the router assigns nobody a
 * resolved ticket. "Reply and resolve" never asks. The engine's `set_status`
 * writes through `reopenWithOwner` itself and must never: a rule in the
 * router's own pass re-arming that pass would run it again, and again, to the
 * router's cap.
 */
export async function changeStatus(
  agentId: string,
  conversationId: string,
  status: StatusTarget,
  via?: 'reply_and_resolve',
  { deferToRouter: mayDefer = false }: { deferToRouter?: boolean } = {},
): Promise<boolean> {
  // For the re-time a deferral owes inside the transaction: read before it
  // opens, and only where one can be owed — the picker, on a decision in
  // flight (`clockInputsIfInFlight`).
  const clocks = mayDefer ? await clockInputsIfInFlight(conversationId) : null;
  const written = await db.transaction(async (tx) => {
    // Through `reopenWithOwner`, as every status writer is, so moving a
    // WhatsApp ticket back out of resolved or closed takes its number's current
    // owner.
    await reopenWithOwner(tx, conversationId, status.category, 'reopened_by_status', async () => {
      await tx
        .update(conversations)
        .set({
          statusId: status.id,
          ...resolveStamp(status.category),
          // Stamped on the way in and left alone otherwise. Moving a ticket
          // back to Open must not erase who resolved it — that record is what
          // the reopening about to follow gets attributed to.
          ...(status.category === 'resolved' ? { resolvedByAgentId: agentId } : {}),
          closedAt: status.category === 'closed' ? new Date() : null,
        })
        .where(eq(conversations.id, conversationId));

      // Stamped once the update above holds the ticket's row lock, never at
      // the transaction's start (`CHANGE_STAMP`): a status change that waited
      // on another writer's lock — the router's decision, an agent's priority
      // — would otherwise sort before the change it waited for, though it
      // could not be made until that one had committed.
      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'status_changed',
        actorAgentId: agentId,
        createdAt: CHANGE_STAMP,
        data: { to: status.name, category: status.category, ...(via ? { via } : {}) },
      });
      return true;
    });

    // After the write, which holds the ticket's lock (`deferToRouter`), so the
    // ticket it asks about is the one the move left — resolved or closed by it,
    // or already marked spam or merged, it keeps its own pass.
    if (!mayDefer || !(await deferToRouter(tx, conversationId))) {
      return { deferred: false, retimed: false };
    }
    if (!clocks) return { deferred: true, retimed: false };
    // Handed over, the clocks pause or resume in this transaction: the
    // router's pass reads the ticket as soon as it commits, and a resume
    // shifted after that left the pass reading the deadline from before the
    // pause was credited — overdue, to a rule that then escalated a ticket
    // that was not.
    await onStatusChangedIn(tx, conversationId, status.stopsSlaClock, clocks);
    return { deferred: true, retimed: true };
  });

  // Whoever runs the pass, the clocks follow the move: pausing or resuming them
  // belongs to the status, not to the rules. After the commit here, before the
  // caller's own pass, unless the deferral above moved them already — a
  // deferral with no inputs to move them with moves them here, its pass handed
  // over all the same.
  if (!written.retimed) await onStatusChanged(conversationId, status.stopsSlaClock);
  if (status.category === 'resolved') await afterTicketResolved(conversationId);
  return written.deferred;
}
