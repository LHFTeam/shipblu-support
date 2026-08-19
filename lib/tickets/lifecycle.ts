import { runAutomations } from '@/lib/automations';
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
 */
export async function afterInboundMessage(
  conversationId: string,
  createdConversation: boolean,
  at: Date = new Date(),
): Promise<void> {
  if (createdConversation) {
    await runAutomations('on_create', conversationId);
    await applySlaOnCreate(conversationId);
    return;
  }

  await onCustomerReply(conversationId, at);
  await runAutomations('on_update', conversationId);
}

/** An agent changed something in the console. */
export async function afterTicketUpdate(conversationId: string): Promise<void> {
  await runAutomations('on_update', conversationId);
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
