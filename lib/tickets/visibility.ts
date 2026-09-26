import { eq, isNull, notInArray, type SQL } from 'drizzle-orm';
import { conversations } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { hiddenChannels } from './channel-policy';
import type { ReadScope } from '@/lib/shipments/queries';

/**
 * Who may see which conversations, as SQL.
 *
 * Exported because the customer, account and shipment pages list conversations
 * too, and re-implementing this rule in four more files is how a bot transcript
 * eventually leaks through a side door. Visibility is enforced in the query and
 * never in the template: an agent who can only see their own tickets must not be
 * able to reach another's by URL, and filtering after the fact would still have
 * loaded the row.
 */
export function conversationVisibility(agent: SessionAgent): SQL[] {
  const where: SQL[] = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];

  if (!can(agent, 'ticket.view.all')) {
    where.push(eq(conversations.assigneeAgentId, agent.id));
  }

  const hidden = hiddenChannels(agent);
  if (hidden.length) where.push(notInArray(conversations.channel, hidden));

  return where;
}

/**
 * The same rule as `conversationVisibility`, in the shape the shipment read
 * model takes.
 *
 * `lib/shipments/queries.ts` deliberately knows nothing about agents — that is
 * the seam the future platform endpoint sits on — so the console has to say what
 * this agent may see. This is the one place that translation happens.
 */
export function scopeForAgent(agent: SessionAgent, overrides: ReadScope = {}): ReadScope {
  return {
    excludeChannels: hiddenChannels(agent),
    onlyAssigneeAgentId: can(agent, 'ticket.view.all') ? undefined : agent.id,
    includeClosed: true,
    ...overrides,
  };
}
