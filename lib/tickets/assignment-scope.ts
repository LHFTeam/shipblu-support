import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversations, groupMembers } from '@/db/schema';
import { notOnCoexistenceNumber } from './owner-only';

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
 * permission says, so the number's half is OR'd in on both branches.
 *
 * On a coexistence number that half is the only way in. Such a number is one
 * person's phone (`lib/tickets/owner-only.ts`), so holding one of its tickets,
 * being accountable for it or sitting in its group shows it to nobody: every
 * other half is asked only of a ticket that is not on one. That takes in the
 * number's copied history, which sits resolved in the number's default group
 * and was readable by every member of it; a ticket a colleague was given; and
 * what stays accountable to a previous owner after a handover, whose chats
 * went with the phone. An agent who sees every ticket never reaches this
 * predicate, so they still see these, and are who sees them while the number
 * has no owner.
 */
export function heldByOrInGroupsOf(agentId: string, includeGroups: boolean): SQL {
  const elsewhere = or(
    eq(conversations.assigneeAgentId, agentId),
    eq(conversations.accountableAgentId, agentId),
    includeGroups ? inGroupsOf(agentId) : undefined,
  )!;
  return or(onNumberOwnedBy(agentId), and(notOnCoexistenceNumber(), elsewhere))!;
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
 * Every ticket on a WhatsApp number this agent owns: what has arrived on it and
 * nobody has taken, what a colleague holds, and its copied history, which
 * nobody is accountable for.
 *
 * With `accountable_agent_id`, asked beside it, this is what an owner answers
 * for without necessarily holding. A breach on an owned ticket counts against
 * its owner whoever it is reassigned to (`accountableOrAssignee()`), so an
 * owner who could see only what they hold would be measured on work hidden
 * from them — and an owner may well be an agent-role user in no group, for
 * whom "what they hold" was all there was. The accountable half covers what
 * stays theirs after a plain number moves on: a ticket that was resolved when
 * it was handed over keeps its accountable agent until its customer writes
 * again.
 *
 * Read in the query on every request, like group membership, so a handover
 * takes a number's tickets from one owner and gives them to the next at their
 * next page rather than at their next sign-in. The column alone, with no test
 * of the owner being active: a deactivated agent has no session to ask with.
 */
function onNumberOwnedBy(agentId: string): SQL {
  return inArray(
    conversations.channelId,
    db.select({ id: channels.id }).from(channels).where(eq(channels.ownerAgentId, agentId)),
  );
}
