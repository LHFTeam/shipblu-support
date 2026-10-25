import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, ticketCategories } from '@/db/schema';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';

/**
 * Who set a ticket's category: an agent in the console, or a rule, Jev or a
 * form by name — the two columns every timeline event already has for that.
 */
export type CategoryActor = { agentId: string } | { label: string };

export type CategoryWrite =
  | { outcome: 'changed'; from: string | null; to: string | null }
  | { outcome: 'unchanged' }
  | { outcome: 'unknown_category' | 'retired_category' | 'no_ticket' };

/**
 * Writes `conversations.category_id` and its `category_changed` event, in one
 * transaction — the one way the console and the automation engine set a
 * category, so neither can write the column without the event that says who
 * did.
 *
 * Shaped like priority's writers, for the reason `CHANGE_STAMP` gives: the
 * ticket's row is locked before anything is compared, and the event is stamped
 * once the update holds that lock, so the timeline orders two writers the way
 * the column was written. Jev's classifier (Stage 4) decides whether it may
 * still set a ticket's category from those events, so an event sorting before
 * the change it overruled would hand a ticket back to the model after a person
 * had answered for it.
 *
 * Setting what the ticket already carries writes nothing — no update, no
 * event — so a time rule matching every fifteen minutes records its decision
 * once. A retired category is refused: retiring one says no new ticket goes
 * there, and a rule or a picker naming it from before is out of date.
 *
 * What it does not do is anything that follows from the change. The caller
 * re-chooses the SLA policy once this has committed
 * (`reselectPolicyBeforeFirstResponse`) and runs whatever observer rules it
 * runs, because those take the ticket's lock themselves and must not wait on
 * this transaction. And it never writes `requester_kind`: the category says
 * whose work a ticket is, not who the requester is.
 */
export async function setConversationCategory(
  conversationId: string,
  categoryId: string | null,
  actor: CategoryActor,
): Promise<CategoryWrite> {
  return db.transaction(async (tx): Promise<CategoryWrite> => {
    const [ticket] = await tx
      .select({ categoryId: conversations.categoryId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('update');
    if (!ticket) return { outcome: 'no_ticket' };
    if (ticket.categoryId === categoryId) return { outcome: 'unchanged' };

    let category: { key: string; labelEn: string } | null = null;
    if (categoryId) {
      // Share-locked, so an admin retiring it meanwhile waits for this write
      // rather than landing between the check and it.
      const [found] = await tx
        .select({
          key: ticketCategories.key,
          labelEn: ticketCategories.labelEn,
          isActive: ticketCategories.isActive,
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .for('share');
      if (!found) return { outcome: 'unknown_category' };
      if (!found.isActive) return { outcome: 'retired_category' };
      category = found;
    }

    await tx.update(conversations).set({ categoryId }).where(eq(conversations.id, conversationId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'category_changed',
      ...('agentId' in actor ? { actorAgentId: actor.agentId } : { actorLabel: actor.label }),
      createdAt: CHANGE_STAMP,
      // The key and label as they were at the change, so the timeline still
      // says what was chosen after an admin renames the category.
      data: {
        from: ticket.categoryId,
        to: categoryId,
        key: category?.key ?? null,
        label: category?.labelEn ?? null,
      },
    });

    return { outcome: 'changed', from: ticket.categoryId, to: categoryId };
  });
}
