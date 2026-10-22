import { eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversations, groupMembers } from '@/db/schema';

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
 *
 * The owner of a WhatsApp number sees its tickets whatever the group
 * permission says (`answerableBy`), so it is OR'd in on both branches.
 */
export function heldByOrInGroupsOf(agentId: string, includeGroups: boolean): SQL {
  const mine = or(eq(conversations.assigneeAgentId, agentId), answerableBy(agentId))!;
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

/**
 * Tickets this agent answers for without necessarily holding them: the ones
 * accountable to them, and every ticket on a WhatsApp number they own.
 *
 * A breach on an owned ticket counts against its owner whoever it is
 * reassigned to (`accountableOrAssignee()`), so an owner who could see only
 * what they hold would be measured on work hidden from them — and an owner may
 * well be an agent-role user in no group, for whom "what they hold" was all
 * there was.
 * Both halves, because they cover different tickets. The number's covers what
 * arrives on it now: an unassigned ticket, one a colleague is working, its
 * copied history, which nobody is accountable for. The accountable one covers
 * what stays theirs after the number moves on — a ticket that was resolved
 * when it was handed over keeps its accountable agent until its customer
 * writes again.
 *
 * Read in the query on every request, like group membership, so a handover
 * takes a number's tickets from one owner and gives them to the next at their
 * next page rather than at their next sign-in.
 */
function answerableBy(agentId: string): SQL {
  return or(
    eq(conversations.accountableAgentId, agentId),
    inArray(
      conversations.channelId,
      db.select({ id: channels.id }).from(channels).where(eq(channels.ownerAgentId, agentId)),
    ),
  )!;
}
