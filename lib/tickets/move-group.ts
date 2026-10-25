import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';

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
 * The console's group case and `assign_group` write through this; the routing
 * half of `assignConversation` answers the same question as `movedGroup`.
 */
export async function moveToGroupIfElsewhere(
  conversationId: string,
  groupId: string | null,
  executor: typeof db = db,
): Promise<boolean> {
  const moved = await executor
    .update(conversations)
    .set({ groupId })
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`${conversations.groupId} is distinct from ${groupId}`,
      ),
    )
    .returning({ id: conversations.id });
  return moved.length > 0;
}
