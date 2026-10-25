import { and, eq, exists, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, groups } from '@/db/schema';

/**
 * Puts a ticket in `groupId` when it is somewhere else, and answers whether it
 * moved.
 *
 * What a group writer asks before it records a move, re-times the clocks or
 * owes the SLA policy a second look. A rule naming the group a ticket is
 * already in matches on every pass — every customer message, every sweep for a
 * time rule — and a console page drawn before somebody else moved the ticket
 * posts the group it is in now. Neither changes anything. Treated as a move,
 * each wrote a `group_changed` event, and before the first response had
 * `reselectPolicyBeforeFirstResponse` take up whatever else had changed since
 * the policy was chosen — a raised priority, a new tag — as though the group
 * had, against `onPriorityChanged`'s rule that a priority keeps its policy.
 *
 * Every group writer moves through this — the console's group case,
 * `assign_group`, and the routing half of `assignConversation`, which reports
 * the answer as `movedGroup` — so they cannot come to disagree about what a
 * move is. `groupMustExist` is the router's: it reaches here without having
 * looked the group up, and a rule naming a group deleted since would otherwise
 * throw on the foreign key and take the assignment down with it.
 */
export async function moveToGroupIfElsewhere(
  conversationId: string,
  groupId: string | null,
  {
    executor = db,
    groupMustExist = false,
  }: { executor?: typeof db; groupMustExist?: boolean } = {},
): Promise<boolean> {
  const moved = await executor
    .update(conversations)
    .set({ groupId })
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`${conversations.groupId} is distinct from ${groupId}`,
        groupMustExist && groupId
          ? exists(db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)))
          : undefined,
      ),
    )
    .returning({ id: conversations.id });
  return moved.length > 0;
}
