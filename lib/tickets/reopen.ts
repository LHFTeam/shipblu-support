import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversationEvents, conversations } from '@/db/schema';
import { reopenWithOwner } from '@/lib/whatsapp/number-owner';
import { resolveStamp } from './resolve-stamp';
import { lockedStatusCategory, statusCategoryOf } from './status-category';
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
 * What is checked here is only whether the caller's answer still holds. Every
 * caller decided from a read with no lock, so an agent or a rule could have put
 * the ticket back in a queue before this ran; the stale answer then reopened an
 * open ticket, counting a reopen against its resolver, with a second `reopened`
 * event, for a customer who never came back to a resolved one. So the status is
 * read again under the ticket's own lock, and a ticket open or pending by then
 * is left as it is: the message is stored on it, in its queue. One closed in
 * the meantime is still reopened, as it always was, because the caller has
 * chosen this ticket for the message, and a closed one is in no queue to be
 * seen in. The count is raised from the row, never from the caller's read.
 *
 * Returns false and changes nothing when there is nothing to reopen, or when no
 * open status exists — the leniency every copy had: the message is still
 * stored, on the resolved ticket, rather than refused.
 *
 * The SLA clock the resolve paused is not resumed here: this runs inside the
 * caller's transaction, and the resume reads committed rows and the ticket's
 * calendar. Every reopen is a customer writing, so `onCustomerReply` closes it
 * after the commit, at this event's instant (`closeStrayPause`).
 */
export async function reopenResolved(
  tx: typeof db,
  ticket: { id: string },
  by: { actorLabel: string; reason: ReopenReason },
): Promise<boolean> {
  const statusId = await defaultOpenStatusId(tx);
  if (!statusId) return false;

  // Through `reopenWithOwner`, as every status writer is: a WhatsApp ticket
  // coming back takes its number's current owner, here for every customer's
  // reopen at once — WhatsApp, the portal and any path added later.
  return reopenWithOwner(tx, ticket.id, 'open', 'reopened_after_handover', async () => {
    // Locked and read in one statement, the status through a subquery rather
    // than a join, for the reason AGENTS.md's locked-read rule gives. A
    // WhatsApp ticket on a number's row is already held (`ownerOnReopen`),
    // and the number's lock before it, so this takes nothing new there.
    const [locked] = await tx
      .select({ statusId: conversations.statusId, statusCategory: statusCategoryOf() })
      .from(conversations)
      .where(eq(conversations.id, ticket.id))
      .for('no key update');
    if (!locked) return false;
    const category = await lockedStatusCategory(tx, locked);
    if (category === 'open' || category === 'pending') return false;

    // `resolvedByAgentId` is deliberately not cleared here, so it survives
    // to be read back below.
    const reopened = await tx
      .update(conversations)
      .set({
        statusId,
        ...resolveStamp('open'),
        reopenCount: sql`${conversations.reopenCount} + 1`,
      })
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
  });
}
