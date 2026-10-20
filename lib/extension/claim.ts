import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, channels, conversationEvents, conversations } from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { isUuid } from '@/lib/http/uuid';
import { canSeeChannel } from '@/lib/tickets/channel-policy';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';

/**
 * "Take this ticket" from the WhatsApp Web side panel.
 *
 * An agent with the plain `agent` role sees only tickets assigned to them, and
 * nothing a business does on a coexistence number assigns one: a reply typed in
 * WhatsApp Web or on the phone arrives as an echo with no author. So the agent
 * answering a chat would open the panel to "not found" on the very ticket they
 * are working. The user chose assign-on-use over widening the visibility rule:
 * the rule stays the console's, and the panel offers to make the ticket theirs.
 *
 * Three limits, each closing something the button could otherwise be used for:
 *
 * - **An unassigned ticket only.** A ticket somebody already holds is refused
 *   with their name. Taking it from them is a reassignment, which the console
 *   already offers to the people who may see both; a button in a side panel
 *   doing it would let two agents each press it in turn.
 * - **A coexistence WhatsApp number only.** The reason to let an agent claim a
 *   ticket they cannot see is that they are looking at its chat in WhatsApp Web
 *   already. That is true of no other channel, and without this limit any
 *   unassigned ticket whose id an agent knew would be one request away.
 * - **The conditional update is the decision.** `assignee_agent_id is null` in
 *   the `where`, so two agents pressing at once leave one owner and one answer
 *   naming them, rather than the second silently overwriting the first.
 *
 * Asks `ticket.assign`, the console's permission for setting an assignee, and
 * writes the same `assigned` event the console's picker does, so the timeline
 * says who took it.
 */
export type ClaimResult =
  | { kind: 'claimed' }
  /** Already theirs — pressed twice, or in two tabs. */
  | { kind: 'already_yours' }
  | { kind: 'held'; assigneeName: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'not_found' };

export async function claimTicket(
  agent: SessionAgent,
  conversationId: string,
): Promise<ClaimResult> {
  if (!can(agent, 'ticket.assign')) {
    return { kind: 'refused', reason: 'You do not have permission to take tickets' };
  }
  if (!isUuid(conversationId)) return { kind: 'not_found' };

  const rows = await db
    .select({
      channel: conversations.channel,
      assigneeAgentId: conversations.assigneeAgentId,
      deletedAt: conversations.deletedAt,
      mergedIntoId: conversations.mergedIntoId,
      channelConfig: channels.config,
    })
    .from(conversations)
    .leftJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  // Every refusal of scope reads as a ticket that does not exist, as the
  // console's visibility rule does: telling an agent "that ticket is on a
  // channel you cannot claim from" confirms it is there.
  if (
    !row ||
    row.deletedAt ||
    row.mergedIntoId ||
    row.channel !== 'whatsapp' ||
    !parseCoexistence(row.channelConfig) ||
    !canSeeChannel(agent, row.channel)
  ) {
    return { kind: 'not_found' };
  }

  if (row.assigneeAgentId === agent.id) return { kind: 'already_yours' };

  const claimed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(conversations)
      .set({ assigneeAgentId: agent.id, assignedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.assigneeAgentId)))
      .returning({ id: conversations.id });
    if (updated.length === 0) return false;

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'assigned',
      actorAgentId: agent.id,
      data: { to: agent.id },
    });
    return true;
  });

  if (claimed) return { kind: 'claimed' };

  // Somebody holds it — whoever it was before this request, or whoever won the
  // race just now. Re-read, so the name is the current owner's.
  const holder = await db
    .select({ id: agents.id, name: agents.name })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (holder[0]?.id === agent.id) return { kind: 'already_yours' };
  return { kind: 'held', assigneeName: holder[0]?.name ?? 'another agent' };
}
