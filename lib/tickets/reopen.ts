import { eq } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversationEvents, conversations } from '@/db/schema';
import { defaultOpenStatusId } from './statuses';

/** Why a resolved ticket went back to open: the web chat's visitor wrote, or any other customer did. */
type ReopenReason = 'customer_replied' | 'visitor_replied';

/**
 * Put a resolved ticket back in the open queue, and say so on its timeline.
 *
 * One copy, for the five inbound paths that reopen — email, WhatsApp, Meta, the
 * widget and the portal. Each wrote its own, and they had to agree on the
 * update, the snapshot and the event down to its key names, because the reports
 * read all five as one. What stays with the caller is whether to reopen at all:
 * only a `resolved` ticket reopens, and email also stores an autoresponder's
 * message on a resolved ticket without reopening it. A check here would hide a
 * decision that differs by channel inside the one step that does not.
 *
 * Returns false and changes nothing when no open status exists — the leniency
 * every copy had: the message is still stored, on the resolved ticket, rather
 * than refused.
 *
 * The SLA clock the resolve paused is not resumed here: this runs inside the
 * caller's transaction, and the resume reads committed rows and the ticket's
 * calendar. Every reopen is a customer writing, so `onCustomerReply` closes it
 * after the commit, at this event's instant (`closeStrayPause`).
 */
export async function reopenResolved(
  tx: typeof db,
  ticket: { id: string; reopenCount: number },
  by: { actorLabel: string; reason: ReopenReason },
): Promise<boolean> {
  const statusId = await defaultOpenStatusId(tx);
  if (!statusId) return false;

  // `resolvedByAgentId` is deliberately not cleared here, so it survives
  // to be read back below.
  const reopened = await tx
    .update(conversations)
    .set({ statusId, resolvedAt: null, reopenCount: ticket.reopenCount + 1 })
    .where(eq(conversations.id, ticket.id))
    .returning({ resolvedBy: conversations.resolvedByAgentId });

  await tx.insert(conversationEvents).values({
    conversationId: ticket.id,
    type: 'reopened',
    actorLabel: by.actorLabel,
    // The resolver is snapshotted onto the event rather than looked up
    // later. `conversations.resolved_by_agent_id` is overwritten by the
    // next resolution, and the nightly rollup rebuilds the last three
    // days — so reading it at report time would let a ticket resolved
    // again by somebody else silently move this reopening onto them.
    data: { reason: by.reason, resolvedBy: reopened[0]?.resolvedBy ?? null },
  });

  return true;
}
