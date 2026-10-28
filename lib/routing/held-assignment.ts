import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';

type Strategy = NonNullable<(typeof routingDecisions.$inferSelect)['heldStrategy']>;

/**
 * An `auto_assign` rule's pick, asked for while the ticket was held for the
 * router (`plans/ticket-category-routing.md`, decision 5), kept for whatever
 * ends the hold to make (`afterHoldEnded`).
 *
 * `assignConversation` answers such a rule `awaiting_route` before it reads a
 * strategy at all, and the hold's end assigned with the group's own. So a rule
 * that overrides the strategy — round robin over a group an admin leaves on
 * `manual`, the way a rule turns assignment on for a ticket without moving it
 * — left every held ticket unassigned, where the same rule assigns every
 * ticket nothing holds.
 *
 * Kept on the ticket's routing row, which exists exactly while there is a hold
 * to wait for. Phase one clears it when the router's own rules follow, so they
 * record only a rule that still matches the ticket as the decision left it,
 * and `endHold` clears it, since a person or a rule has decided instead.
 */
export async function recordHeldAssignment(
  conversationId: string,
  strategy: Strategy,
  actorLabel: string,
): Promise<void> {
  // One statement, on the pool: the caller holds no transaction, so this
  // holds no lock but the routing row's, and cannot close a cycle with the
  // router, which takes the ticket's row first. Undecided only: a hold that
  // ended in between has already been assigned, or tried, by whatever ended
  // it, and a strategy written after that would never be read.
  await db
    .update(routingDecisions)
    .set({ heldStrategy: strategy, heldActorLabel: actorLabel })
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
        eq(routingDecisions.shadow, false),
      ),
    );
}

/**
 * What a hold that has ended still owes, off its routing row: the message the
 * held reply answers, and the rule's pick if one was kept. Null for a ticket
 * that never routed.
 */
export async function heldFollowUp(conversationId: string): Promise<{
  messageId: string | null;
  strategy: Strategy | null;
  actorLabel: string | null;
} | null> {
  const [row] = await db
    .select({
      messageId: routingDecisions.messageId,
      strategy: routingDecisions.heldStrategy,
      actorLabel: routingDecisions.heldActorLabel,
    })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  return row ?? null;
}
