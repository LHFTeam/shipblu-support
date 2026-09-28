import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, type ticketStatuses } from '@/db/schema';
import { onStatusChanged } from '@/lib/sla';
import { afterTicketResolved } from '@/lib/tickets/lifecycle';

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
 */
export async function changeStatus(
  agentId: string,
  conversationId: string,
  status: StatusTarget,
  via?: 'reply_and_resolve',
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({
        statusId: status.id,
        resolvedAt: status.category === 'resolved' ? new Date() : null,
        // Stamped on the way in and left alone otherwise. Moving a ticket
        // back to Open must not erase who resolved it — that record is what
        // the reopening about to follow gets attributed to.
        ...(status.category === 'resolved' ? { resolvedByAgentId: agentId } : {}),
        closedAt: status.category === 'closed' ? new Date() : null,
      })
      .where(eq(conversations.id, conversationId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'status_changed',
      actorAgentId: agentId,
      data: { to: status.name, category: status.category, ...(via ? { via } : {}) },
    });
  });

  await onStatusChanged(conversationId, status.stopsSlaClock);
  if (status.category === 'resolved') await afterTicketResolved(conversationId);
}
