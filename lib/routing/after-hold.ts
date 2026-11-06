import { assignConversation } from '@/lib/assignment';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { logger } from '@/lib/log';
import { afterRoutingChanged } from '@/lib/sla';
import { heldFollowUp } from './held-assignment';

const log = logger('routing');

/**
 * What a hold owed once it is over, whatever ended it — the router's decision,
 * `settle_routing`, or a person or rule through `endHold`: what a category Jev
 * wrote handed the router, when a person or a rule ended the hold before the
 * router could (`heldFollowUp`'s `categoryOwed`) — the `on_update` pass, for an
 * ending that ran none of its own (`runOwedPass`), and the SLA policy's look;
 * the assignment the creation pass held back, and its out-of-hours reply, to the message the hold
 * kept from being acknowledged: the one that opened the ticket, which the
 * creation pass would have answered had nothing been held — or, on a comment
 * thread a passer-by's reply opened, the customer's own comment, which arrived
 * during the hold and made them the requester (`heldFollowUp`).
 *
 * Owed by state rather than by one caller, so every way a hold ends calls this
 * once its own transaction has committed, and it reads what is owed off the
 * routing row itself: the message to answer, and the pick an `auto_assign`
 * rule asked for while the ticket was held. The reply's claim on
 * `auto_responded_at` keeps it to one, and its guards to a ticket still open
 * that nobody has answered — so an agent's reply that ended the hold at 23:00
 * is not followed by "we are closed".
 *
 * Best-effort, like every lifecycle step: these run inside jobs and actions,
 * and a throw would fail what has already been written.
 *
 * Not in `apply.ts`, which imports the automation engine: the engine calls this
 * after a pass whose rule ended a hold, and would import itself.
 */
export async function afterHoldEnded(
  conversationId: string,
  now: Date = new Date(),
  ending: {
    /**
     * The `on_update` pass, for a write that ended the hold and runs none of
     * its own: an agent's reply. Every other ending runs one after its commit,
     * which reads the category Jev wrote before it — the console's group and
     * assignee cases (`afterTicketUpdate`), Hand to, and an engine rule's
     * pass, which is one. Handed in rather than imported, for the reason this
     * module is not in `apply.ts`.
     */
    runOwedPass?: () => Promise<unknown>;
  } = {},
): Promise<void> {
  let held: Awaited<ReturnType<typeof heldFollowUp>> = null;
  try {
    held = await heldFollowUp(conversationId);
  } catch (error) {
    log.error(`could not read what the hold on ${conversationId} owed`, error);
  }

  // The rules, then the policy, then the assignment, as the router's own end
  // of a hold runs them (`finish`): a person's or a rule's end of a hold whose
  // category is Jev's leaves the policy where the creation pass chose it, and,
  // ended by an agent's reply, the rules keyed on the category unrun
  // (`heldFollowUp`).
  try {
    if (held?.categoryOwed && ending.runOwedPass) await ending.runOwedPass();
  } catch (error) {
    log.error(`could not run the rules ${conversationId}'s category was owed`, error);
  }

  try {
    if (held?.categoryOwed) {
      await afterRoutingChanged(conversationId, { category: true, group: false });
    }
  } catch (error) {
    log.error(`could not choose the policy for ${conversationId} after its hold`, error);
  }

  try {
    // With the strategy and the label of the rule that asked while the ticket
    // was held (`recordHeldAssignment`), so the pick is the one the rule meant
    // and the timeline names the rule; otherwise the group's own, as the
    // creation pass would have.
    await assignConversation(conversationId, {
      now,
      strategy: held?.strategy ?? undefined,
      actorLabel: held?.actorLabel ?? undefined,
    });
  } catch (error) {
    log.error(`auto-assignment failed for conversation ${conversationId}`, error);
  }

  try {
    if (held?.messageId) {
      await maybeSendAutoResponse({ conversationId, messageId: held.messageId }, now);
    }
  } catch (error) {
    log.error(`could not send the held reply on ${conversationId}`, error);
  }
}
