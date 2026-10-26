import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, ticketCategories } from '@/db/schema';
import { canonicalUuid } from '@/lib/http/uuid';
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A category a writer may set, with what its `category_changed` freezes about
 * it — and its id as Postgres spells it back, which is the one the writer
 * stores, in the column and in the event alike.
 */
type HeldCategory = { id: string; key: string; labelEn: string };

/**
 * Share-locks a category for the rest of the transaction, or says why it may
 * not be set: gone, or retired. Share-locked rather than only read, so an admin
 * retiring it meanwhile waits for this write rather than landing between the
 * check and it — the foreign key's own lock is a key-share, which a retire does
 * not wait for.
 *
 * The id comes back lower-cased. Postgres reads `0B6F…` and `0b6f…` as one
 * uuid and stores the column lower-case whatever it was handed, but the event's
 * `data.to` is jsonb, kept as written — so an id typed in upper case into a
 * hand-made POST would leave the event naming a spelling the column does not,
 * and from Stage 4 Jev's ownership rule reads one against the other. Not a uuid
 * at all is no category, rather than Postgres's 22P02 out of the transaction
 * that opens a customer's ticket.
 *
 * One of the two halves both category writers share — `setConversationCategory`
 * and `createTicket`, which writes the column in its insert because a category
 * written after the ticket commits arrives after the on-create rules, the first
 * policy selection and assignment's skill match have already read the row.
 */
export async function holdCategory(
  tx: Tx,
  categoryId: string,
): Promise<HeldCategory | 'unknown_category' | 'retired_category'> {
  const id = canonicalUuid(categoryId);
  if (!id) return 'unknown_category';
  const [found] = await tx
    .select({
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      isActive: ticketCategories.isActive,
    })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id))
    .for('share');
  if (!found) return 'unknown_category';
  if (!found.isActive) return 'retired_category';
  return { id, key: found.key, labelEn: found.labelEn };
}

/**
 * The `category_changed` row for a change, the other shared half: who made it,
 * stamped with `CHANGE_STAMP`, and the key and label as they were at the
 * change, so the timeline still says what was chosen after an admin renames the
 * category.
 */
export function categoryChangedEvent(
  conversationId: string,
  change: { from: string | null; to: string | null; category: HeldCategory | null },
  actor: CategoryActor,
) {
  return {
    conversationId,
    type: 'category_changed',
    ...('agentId' in actor ? { actorAgentId: actor.agentId } : { actorLabel: actor.label }),
    createdAt: CHANGE_STAMP,
    data: {
      from: change.from,
      to: change.to,
      key: change.category?.key ?? null,
      label: change.category?.labelEn ?? null,
    },
  };
}

/**
 * Writes `conversations.category_id` and its `category_changed` event, in one
 * transaction — the one way the console and the automation engine set a
 * category on a ticket that exists, so neither can write the column without the
 * event that says who did. The other writer is `createTicket`, which sets it in
 * the insert that opens the ticket, from the same two halves above.
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
    // Compared in the column's spelling, so asking in upper case for what the
    // ticket already carries is still nothing to write.
    const wanted = categoryId === null ? null : (canonicalUuid(categoryId) ?? categoryId);
    if (ticket.categoryId === wanted) return { outcome: 'unchanged' };

    let category: HeldCategory | null = null;
    if (categoryId) {
      const held = await holdCategory(tx, categoryId);
      if (typeof held === 'string') return { outcome: held };
      category = held;
    }
    const to = category?.id ?? null;

    await tx
      .update(conversations)
      .set({ categoryId: to })
      .where(eq(conversations.id, conversationId));

    await tx
      .insert(conversationEvents)
      .values(
        categoryChangedEvent(conversationId, { from: ticket.categoryId, to, category }, actor),
      );

    return { outcome: 'changed', from: ticket.categoryId, to };
  });
}
