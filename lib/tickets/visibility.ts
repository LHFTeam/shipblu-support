import { and, asc, eq, exists, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, groupMembers, groups } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { heldByOrInGroupsOf } from './assignment-scope';
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

  const assignment = assignmentVisibility(agent);
  if (assignment) where.push(assignment);

  const hidden = hiddenChannels(agent);
  if (hidden.length) where.push(notInArray(conversations.channel, hidden));

  return where;
}

/**
 * Which tickets an agent may see by who holds them, decided from their
 * permissions: undefined for every ticket, otherwise their own, and — with
 * `ticket.view.group` — every ticket sitting in a group they belong to,
 * whoever holds it or whether anybody does.
 *
 * The group half is what makes a group a queue. Without it a ticket routed into
 * a group and not yet assigned (out of hours, everybody at capacity, nobody
 * accepting) was visible to no agent-role user at all, since every one of them
 * saw only what was assigned to them. Seven places used to spell "assigned to
 * me unless `ticket.view.all`" out for themselves. Now which tickets an agent
 * may see is decided here and nowhere else: the inbox list, the ticket page,
 * the action guard and the attachment route take it as SQL in their own query
 * (`assignmentVisibility`), an action that may have moved the ticket asks again
 * (`seesTicket`), the counts as the primitives their request cache is keyed on, the shipment read model as its
 * `onlyVisibleTo` (`scopeForAgent`), and the inbox's group views — which groups
 * to offer (`inboxGroupsFor`) and which views — from the same answer. So a
 * group member who can list a ticket can also open it, act on it and download
 * what is attached to it, and is offered a view for exactly the groups whose
 * tickets they can list.
 *
 * Membership is read in the query rather than carried on the session, so
 * taking an agent out of a group takes the group's tickets away at their next
 * request rather than at their next sign-in.
 */
export function assignmentScope(
  agent: SessionAgent,
): { agentId: string; includeGroups: boolean } | undefined {
  if (can(agent, 'ticket.view.all')) return undefined;
  return { agentId: agent.id, includeGroups: can(agent, 'ticket.view.group') };
}

/** `assignmentScope` as a condition on `conversations`. */
export function assignmentVisibility(agent: SessionAgent): SQL | undefined {
  const scope = assignmentScope(agent);
  return scope && heldByOrInGroupsOf(scope.agentId, scope.includeGroups);
}

/**
 * Whether the agent may still see one ticket by who holds it, read fresh — for
 * an action that has just written something that can move it, as
 * `updateTicket` reassigning or regrouping does. The same SQL the lists run
 * rather than a JavaScript twin of it, so the two cannot drift, and no read at
 * all for an agent who sees every ticket.
 */
export async function seesTicket(agent: SessionAgent, conversationId: string): Promise<boolean> {
  const visibility = assignmentVisibility(agent);
  if (!visibility) return true;
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), visibility))
    .limit(1);
  return rows.length > 0;
}

/**
 * The groups the inbox offers an agent: every group, for one who sees every
 * ticket, and their own for one who sees their groups'. `member` says which
 * are theirs, which is what "My groups" lists.
 *
 * An agent with neither permission is offered none, because a group view would
 * be a list `listInbox` empties for them.
 */
export async function inboxGroupsFor(
  agent: SessionAgent,
): Promise<{ id: string; name: string; member: boolean }[]> {
  const scope = assignmentScope(agent);
  const viewAll = !scope;
  if (scope && !scope.includeGroups) return [];

  const member = exists(
    db
      .select({ one: sql`1` })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groups.id), eq(groupMembers.agentId, agent.id))),
  );

  return db
    .select({ id: groups.id, name: groups.name, member: sql<boolean>`${member}` })
    .from(groups)
    .where(viewAll ? undefined : member)
    .orderBy(asc(groups.name));
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
    onlyVisibleTo: assignmentScope(agent),
    includeClosed: true,
    ...overrides,
  };
}
