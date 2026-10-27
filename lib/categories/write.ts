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

type CategoryRead = HeldCategory | 'unknown_category' | 'retired_category';

/**
 * What a person is told when a category may not be set, in every place that
 * sets one — the ticket sidebar, the console's New form and a form's default —
 * so the three cannot come to answer differently about the same category.
 */
export const CATEGORY_REFUSALS = {
  unknown_category: 'Unknown category',
  retired_category: 'That category has been retired — choose another',
} as const satisfies Record<'unknown_category' | 'retired_category', string>;

/**
 * The one read of the registry for a category somebody wants to set: gone,
 * retired, or what its `category_changed` freezes about it. Not a uuid at all
 * is no category, rather than Postgres's 22P02 out of the transaction that
 * opens a customer's ticket.
 *
 * The id comes back lower-cased. Postgres reads `0B6F…` and `0b6f…` as one
 * uuid and stores the column lower-case whatever it was handed, but the event's
 * `data.to` is jsonb, kept as written — so an id typed in upper case into a
 * hand-made POST would leave the event naming a spelling the column does not,
 * and Jev's ownership rule (`categoryOwned`) reads one against the other.
 */
async function readCategory(
  on: typeof db | Tx,
  categoryId: string,
  lock: boolean,
): Promise<CategoryRead> {
  const id = canonicalUuid(categoryId);
  if (!id) return 'unknown_category';
  const query = on
    .select({
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      isActive: ticketCategories.isActive,
    })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id));
  const [found] = lock ? await query.for('share') : await query;
  if (!found) return 'unknown_category';
  if (!found.isActive) return 'retired_category';
  return { id, key: found.key, labelEn: found.labelEn };
}

/**
 * Share-locks a category for the rest of the transaction, or says why it may
 * not be set: gone, or retired. Share-locked rather than only read, so an admin
 * retiring it meanwhile waits for this write rather than landing between the
 * check and it — the foreign key's own lock is a key-share, which a retire does
 * not wait for.
 *
 * One of the two halves both category writers share — `setConversationCategory`
 * and `createTicket`, which writes the column in its insert because a category
 * written after the ticket commits arrives after the on-create rules, the first
 * policy selection and assignment's skill match have already read the row.
 */
export function holdCategory(tx: Tx, categoryId: string): Promise<CategoryRead> {
  return readCategory(tx, categoryId, true);
}

/**
 * The same question asked before a transaction opens, holding nothing: an
 * early refusal with a sentence, for a caller about to do something a refusal
 * should come before. It promises nothing about the write — the writer asks
 * again under `holdCategory`.
 */
export function checkCategory(categoryId: string): Promise<CategoryRead> {
  return readCategory(db, categoryId, false);
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
  detail?: CategoryEventDetail,
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
      ...detail,
    },
  };
}

/**
 * What a classifier's write adds to its event: the evidence a `priority_changed`
 * from Jev carries — the probability, which the timeline already renders, and
 * the model — and which message the answer was about, and when it was written,
 * so the classifier can tell from the event alone whether a later message's
 * answer arrived after this one settled the ticket.
 */
export type CategoryEventDetail = {
  probability: number | null;
  model: string | null;
  messageId: string | null;
  messageCreatedAt: string;
  runLabel: string;
};

/**
 * Writes `conversations.category_id` and its `category_changed` event, in one
 * transaction — the one way the console and the automation engine set a
 * category on a ticket that exists, so neither can write the column without the
 * event that says who did. Jev's classifier writes the same way inside its own
 * transaction (`setConversationCategoryOn`, below). The other writer is
 * `createTicket`, which sets it in the insert that opens the ticket, from the
 * same two halves above.
 *
 * Shaped like priority's writers, for the reason `CHANGE_STAMP` gives: the
 * ticket's row is locked before anything is compared, and the event is stamped
 * once the update holds that lock, so the timeline orders two writers the way
 * the column was written. Jev's classifier decides whether it may still set a
 * ticket's category from those events, so an event sorting before the change
 * it overruled would hand a ticket back to the model after a person had
 * answered for it.
 *
 * Setting what the ticket already carries writes nothing — no update, no
 * event — so a time rule matching every fifteen minutes records its decision
 * once. A retired category is refused: retiring one says no new ticket goes
 * there, and a rule or a picker naming it from before is out of date.
 *
 * What it does not do is anything that follows from the change. The caller
 * passes the outcome to `afterRoutingChanged` once this has committed, which
 * re-chooses the SLA policy, and runs whatever observer rules it runs, because
 * those take the ticket's lock themselves and must not wait on this
 * transaction. And it never writes `requester_kind`: the category says
 * whose work a ticket is, not who the requester is.
 */
export async function setConversationCategory(
  conversationId: string,
  categoryId: string | null,
  actor: CategoryActor,
): Promise<CategoryWrite> {
  return db.transaction((tx) => setConversationCategoryOn(tx, conversationId, categoryId, actor));
}

/**
 * `setConversationCategory`'s write, inside a transaction the caller already
 * holds — for a writer that decides under the ticket's lock and must write
 * under the same one, as Jev's classifier does: it reads who owns the category
 * and whether the ticket has settled, and nothing may land between that answer
 * and the write. Calling `setConversationCategory` from inside that transaction
 * instead would open a second one on another pooled connection, whose row lock
 * waits on the first while the first waits on it.
 *
 * Locks the ticket's row again, which inside one transaction costs nothing, so
 * the lock order — ticket, then category — is the same whoever calls it.
 */
export async function setConversationCategoryOn(
  tx: Tx,
  conversationId: string,
  categoryId: string | null,
  actor: CategoryActor,
  detail?: CategoryEventDetail,
): Promise<CategoryWrite> {
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
      categoryChangedEvent(
        conversationId,
        { from: ticket.categoryId, to, category },
        actor,
        detail,
      ),
    );

  return { outcome: 'changed', from: ticket.categoryId, to };
}

/**
 * `setConversationCategoryOn` for a write that owes no follow-up by design:
 * `backfill_category_ai`'s apply mode, which files an open backlog from a
 * record label's answers and fires nothing — no SLA policy chosen again, no
 * rule pass, no router — and reports which rules filing would have woken
 * instead (`plans/ticket-category-routing.md`, 4.1).
 *
 * A writer of its own rather than a comment at the call, so the exemption is a
 * property of a function: `routing-result` lets only the backfill call it, and
 * every other writer of the column still owes `afterRoutingChanged`. The answer
 * is the writer's, and is kept like any other.
 */
export async function fileBacklogCategory(
  tx: Tx,
  conversationId: string,
  categoryId: string,
  actor: CategoryActor,
  detail: CategoryEventDetail,
): Promise<CategoryWrite> {
  return setConversationCategoryOn(tx, conversationId, categoryId, actor, detail);
}
