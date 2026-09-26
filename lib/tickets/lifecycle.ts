import { assignConversation } from '@/lib/assignment';
import { maybeSendAutoResponse } from '@/lib/auto-response';
import { runAutomations } from '@/lib/automations';
import { categoriseFromMessage } from '@/lib/categorise/apply';
import { linkShipmentsFromMessage } from '@/lib/shipments/links';
import { scheduleSurvey } from '@/lib/csat';
import { applySlaOnCreate, onCustomerReply } from '@/lib/sla';

/**
 * What happens to a ticket after something changes it.
 *
 * One seam rather than a growing list of calls at each of the three ingest
 * paths and every console action, so a new phase hooks in once.
 */

/**
 * A customer's message arrived.
 *
 * The order of the two engines is different for a new ticket than for a reply,
 * and both orders are deliberate:
 *
 * - **New ticket.** Automations run *first*, then the SLA is applied. A rule
 *   that raises priority to urgent, or moves the ticket to a group with its own
 *   policy, is describing the ticket the team actually has — and the targets
 *   should be that ticket's targets. Applying the SLA first meant an
 *   auto-escalated ticket silently kept the gentler deadline it arrived with.
 *   Nothing is lost by the swap: an on_create rule cannot usefully ask whether
 *   a response is overdue on a ticket that is one second old.
 *
 * - **Reply to an existing ticket.** The SLA moves first, so an Observer rule
 *   asking `is_first_response_overdue` sees the state the customer's message
 *   just produced rather than the state before it.
 *
 * The out-of-hours acknowledgement goes last in both, and that ordering is also
 * deliberate. It is the only step here that speaks to the customer, so it should
 * describe the ticket the team will actually find in the morning: a rule that
 * moved this one into a group with its own calendar has moved which hours count
 * as closed, and answering before that ran would tell the customer we are open.
 *
 * It is also the only step handed the wall clock rather than `at`. Everything
 * else here is measuring the customer's message and wants the moment it was
 * sent; the acknowledgement is *being sent now* and has to say so — "we open on
 * Sunday at 09:00" is counted from the instant it leaves, not from the header on
 * the mail that prompted it. On email those are not the same instant and the
 * difference is not ours: `receivedAt` is Postmark's `Date`, which is the
 * sender's own header, so a customer whose clock reads 23:00 at 11:00 Cairo
 * would otherwise be told the office is shut in the middle of a working morning.
 */
export async function afterInboundMessage(
  conversationId: string,
  createdConversation: boolean,
  at: Date = new Date(),
  options: { autoReply?: boolean } = {},
): Promise<void> {
  if (createdConversation) {
    await runAutomations('on_create', conversationId);
    await applySlaOnCreate(conversationId);
    await autoAssign(conversationId);
    await maybeSendAutoResponse(conversationId);
    return;
  }

  // An out-of-office asks nothing of the team, so it does not restart the
  // next-response clock: an agent who had answered would otherwise owe a reply
  // to the customer's mail server, and breach on it.
  if (!options.autoReply) await onCustomerReply(conversationId, at);
  await runAutomations('on_update', conversationId);
  await autoAssign(conversationId);
  await maybeSendAutoResponse(conversationId);
}

/** An agent changed something in the console. */
export async function afterTicketUpdate(conversationId: string): Promise<void> {
  await runAutomations('on_update', conversationId);
  await autoAssign(conversationId);
}

/**
 * Hand the ticket to somebody, if its group is configured to do that.
 *
 * Last, and after the automations, because a rule that moves the ticket to
 * another group is describing where the work belongs — assigning first would
 * hand it to a member of the group it is about to leave.
 *
 * It runs on replies and console updates as well as on arrival, and that costs
 * nothing: `assignConversation` returns without a write for a ticket that
 * already has an assignee, which is nearly all of them. What it buys is the
 * ticket that arrived unassigned overnight and is still unassigned when the
 * customer chases it, and the one a rule has just moved into a group that does
 * route.
 *
 * Failures are logged and swallowed, exactly as shipment linking is. These paths
 * run inside queue jobs; throwing here would fail the job, and the retry would
 * re-run every engine that already succeeded — including sending a reply twice.
 */
async function autoAssign(conversationId: string): Promise<void> {
  try {
    await assignConversation(conversationId);
  } catch (error) {
    console.error(`[lifecycle] auto-assignment failed for conversation ${conversationId}`, error);
  }
}

/**
 * A ticket reached a resolved status, however it got there — an agent, "reply
 * and resolve", or an automation.
 *
 * Only the survey hangs off this today. It is scheduled rather than sent, so a
 * customer who reopens the ticket in the next half hour gets their answer
 * instead of a satisfaction survey.
 */
export async function afterTicketResolved(conversationId: string): Promise<void> {
  await scheduleSurvey(conversationId);
}

/**
 * A message was stored, whoever wrote it.
 *
 * A separate seam from `afterInboundMessage` rather than a fourth argument on
 * it, for two reasons.
 *
 * `afterInboundMessage` is deliberately *skipped* on the `whatsapp_bot` channel:
 * SLA clocks, automations and CSAT must not run on a conversation nobody on the
 * team is working. None of that applies to linking a shipment — it is a
 * read-model concern with no side effects — and bot transcripts are exactly
 * where tracking numbers appear in bulk, and exactly what the future platform
 * query wants to find. So this runs there and the other engines still do not.
 *
 * The other reason is that an optional argument silently no-opping at whichever
 * call sites nobody updated is the shape of failure that reports success, which
 * this project has been bitten by before.
 *
 * It runs on **outbound** replies and notes as well as inbound. The common
 * sequence is a customer asking where their parcel is, an agent looking it up on
 * the shipping platform, and the number arriving in the reply or a private note.
 * Scanning only inbound would miss a large share of exactly the tickets worth
 * linking.
 *
 * Failures are logged and swallowed. A detection bug must never fail an ingest
 * job — the job would retry, re-running everything downstream of it.
 */
export type StoredMessage = {
  conversationId: string;
  messageId: string;
  bodyText: string;
  kind: string;
  /**
   * Required and nullable rather than optional, and that is load-bearing.
   *
   * `direction?: string` compiles at every existing call site and silently
   * disables categorisation on whichever ingest path was forgotten — which is
   * precisely the failure this seam's own docstring warns about two paragraphs
   * up. `direction: string` does not compile until somebody has answered the
   * question for each path, which is the whole point of widening the type
   * instead of re-reading the row inside the consumer: re-reading also
   * compiles, and also never asks.
   */
  direction: string;
};

export async function afterMessageStored(message: StoredMessage): Promise<void> {
  try {
    await linkShipmentsFromMessage(message);
  } catch (error) {
    console.error(`[lifecycle] shipment linking failed for message ${message.messageId}`, error);
  }

  // Its own try/catch rather than sharing one: a bug in shipment detection must
  // not stop categorisation, or the reverse. Sequential rather than in parallel
  // because both finish by touching the same `conversations` row, and two
  // concurrent updates of one row from one pool is a deadlock.
  try {
    await categoriseFromMessage(message, 'notify');
  } catch (error) {
    console.error(`[lifecycle] categorisation failed for message ${message.messageId}`, error);
  }
}
