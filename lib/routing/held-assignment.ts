import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages, routingDecisions } from '@/db/schema';
import { notReaction } from '@/lib/tickets/not-reaction';

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
 * Kept on the ticket's routing row, which is undecided exactly while there is
 * a hold to wait for, and cleared there once it no longer speaks for the
 * ticket — by the router's phase one, and by `endHold`, whose person or rule
 * has decided instead (`db/schema/routing.ts` says when).
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
 *
 * The message is the one the hold kept from being acknowledged, which is the
 * one that opened the ticket only while its author is still the requester. A
 * comment thread can be opened by a passer-by's reply stored before the
 * customer's own comment, and that comment, arriving during the hold, makes
 * its author the requester (`adoptRootAuthor`) and is held unanswered like
 * everything else. The opening message would then be the passer-by's, which
 * the reply refuses (`answersRequester`), and the requester's comment would
 * never be acknowledged. So it is the requester's earliest message on the
 * ticket — never the newest, which after a batch retried whole is as often
 * somebody else's — and a reaction is no message to acknowledge
 * (`notReaction`). With none of theirs, the opening message stands, and the
 * reply's own guards decide.
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
      requesterContactId: conversations.requesterContactId,
      openedBy: messages.authorContactId,
    })
    .from(routingDecisions)
    .innerJoin(conversations, eq(conversations.id, routingDecisions.conversationId))
    .leftJoin(messages, eq(messages.id, routingDecisions.messageId))
    .where(eq(routingDecisions.conversationId, conversationId));
  if (!row) return null;

  const { requesterContactId, openedBy, ...held } = row;
  if (held.messageId && openedBy === requesterContactId) return held;

  const [first] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        eq(messages.kind, 'reply'),
        eq(messages.authorContactId, requesterContactId),
        notReaction(),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(1);
  return { ...held, messageId: first?.id ?? held.messageId };
}
