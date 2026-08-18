import { runAutomations } from '@/lib/automations';
import { scheduleSurvey } from '@/lib/csat';
import { onInboundMessage } from '@/lib/sla';

/**
 * What happens to a ticket after something changes it.
 *
 * One seam rather than a growing list of calls at each of the three ingest
 * paths and every console action. Phase 3 put two things here; CSAT and
 * reporting will want their own, and the point is that they get added once.
 *
 * Order matters: the SLA clocks move first so that an automation evaluating
 * `is_first_response_overdue` sees the state the customer's message just
 * produced rather than the state before it.
 */

export async function afterInboundMessage(
  conversationId: string,
  createdConversation: boolean,
  at: Date = new Date(),
): Promise<void> {
  await onInboundMessage(conversationId, createdConversation, at);

  // A customer's reply is an update to an existing ticket, which is exactly
  // what an Observer rule is for.
  await runAutomations(createdConversation ? 'on_create' : 'on_update', conversationId);
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
