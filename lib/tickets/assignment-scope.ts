import { eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, groupMembers } from '@/db/schema';

/**
 * Which conversations an agent sees by who holds them, as SQL, knowing nothing
 * about sessions or permissions.
 *
 * Its own module because the shipment read model must not learn about agents
 * (`lib/shipments/queries.ts` is the seam a platform endpoint will sit on) and
 * still has to apply the same rule the console does. `lib/tickets/visibility.ts`
 * decides from an agent's permissions which of these applies; both read the
 * predicate from here, so the inbox and a shipment page cannot disagree about
 * whether a group's ticket is visible.
 */
export function heldByOrInGroupsOf(agentId: string, includeGroups: boolean): SQL {
  const mine = eq(conversations.assigneeAgentId, agentId);
  if (!includeGroups) return mine;
  return or(mine, inGroupsOf(agentId))!;
}

/** Conversations sitting in a group this agent belongs to. */
export function inGroupsOf(agentId: string): SQL {
  return inArray(
    conversations.groupId,
    db
      .select({ id: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.agentId, agentId)),
  );
}
