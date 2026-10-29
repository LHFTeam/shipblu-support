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
 * has decided instead or moved the ticket (`db/schema/routing.ts` says when).
 *
 * A pick is about the queue of the group its rule matched the ticket in, so
 * while the router holds the ticket the one kept is about the group the
 * ticket is in. Two halves hold that. Every move drops a pick kept before it,
 * whoever makes it: phase one its own decision's, and `endHold` (`movedGroup`)
 * a person's, Hand to's or a rule's — in another pass, or later in the very
 * pass that kept the pick, whose rules after the move may keep one again for
 * where the ticket now is. And a pick is kept only while the ticket is still
 * in `groupId`, the group the rule matched it in, checked here under the
 * ticket's lock: a pass that read the ticket before a move goes on to make
 * its picks after it, about the group the ticket has left, and the move has
 * either committed and is seen, so nothing is kept, or waits for this and
 * then drops what this kept. Unless a rule in that pass names the group the
 * move put the ticket in: finding it already there leaves the pass there, as
 * moving it would (the engine's `Pass.groupId`), since in the other order the
 * other writer's move is the one that finds it there, and drops nothing. So
 * the same rules on the same writes give the same holder however they
 * interleave before the hold ends. Not after: a move landing between the
 * router's end of the hold and its assignment meets a decided row, which
 * `endHold` leaves alone, and the pick can be made in the new group under the
 * old group's rule — the race any write then runs with the assignment, left
 * in the plan until the pick carries its group. Checked once the pass was
 * over instead — the router comparing the group with what the pass it re-ran
 * had read — the answer turned on whether an unrelated write had re-armed the
 * pass, and a pass the router never re-ran, its caller having died, left the
 * stale pick for the window's job, which knows nothing of what that pass
 * read. Dropped by a person's move alone, a rule's move after the pick was
 * kept assigned in the new group under the old group's rule, where the same
 * move landing before it assigned nobody.
 *
 * Answers `kept`; `moved` when the ticket is no longer in `groupId`; or
 * `not_held` when there is no undecided live row to keep it on.
 */
export async function recordHeldAssignment(
  conversationId: string,
  strategy: Strategy,
  actorLabel: string,
  groupId: string | null,
): Promise<'kept' | 'moved' | 'not_held'> {
  // The ticket's row first, then the routing row's, the order the router and
  // every writer that re-arms it take them in, so this waits on none of them
  // in the opposite order. NO KEY UPDATE, as every lock on a ticket's row is
  // (`endHold`). The caller holds no transaction, so this is the only lock
  // it holds. Undecided only: a hold that ended in between has already been
  // assigned, or tried, by whatever ended it, and a strategy written after
  // that would never be read.
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ groupId: conversations.groupId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('no key update');
    if (!ticket) return 'not_held';
    if (ticket.groupId !== groupId) return 'moved';
    const kept = await tx
      .update(routingDecisions)
      .set({ heldStrategy: strategy, heldActorLabel: actorLabel })
      .where(
        and(
          eq(routingDecisions.conversationId, conversationId),
          ne(routingDecisions.stage, 'decided'),
          eq(routingDecisions.shadow, false),
        ),
      )
      .returning({ id: routingDecisions.id });
    return kept.length > 0 ? 'kept' : 'not_held';
  });
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
