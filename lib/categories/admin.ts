import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { groups, ticketCategories } from '@/db/schema';
import { UNKNOWN_CATEGORY_KEY } from './registry';

/**
 * Adding, editing and retiring a category: the writes behind
 * `/admin/categories`, each answering the sentence the form shows, or null.
 *
 * Here rather than in the action file so the rules can be tested against
 * Postgres (`admin.db.test.ts`), and so the page's actions only authorise,
 * read the form and call in.
 *
 * Three things are not editable, each for a reason:
 *
 * - **The key**, once the category exists. Every `category_changed` event
 *   freezes the key it was set to, so the timeline still says what was chosen
 *   after a relabel, and Jev answers with a key (`lib/category-ai/`). A key that moved
 *   would leave both naming a category that no longer answers to it. So
 *   `updateCategory` takes no key at all, rather than one it ignores.
 * - **Whether it exists.** There is no delete: `conversations.category_id` and
 *   `ticket_forms.default_category_id` are `restrict`, and a category with
 *   tickets or forms behind it keeps them. Retiring takes it out of every
 *   picker and refuses it as a new value (`setConversationCategory`, and
 *   `createTicket`, which opens the ticket without it), and restoring puts it
 *   back.
 * - **`is_system`**, which says the row came from the seed. An admin's
 *   category is never one, so `seed_ticket_categories` reporting an orphan
 *   always means a key the code dropped.
 */

/** The fields an admin edits on an existing category. */
export type CategoryEdit = {
  labelEn: string;
  labelAr: string;
  description: string;
  position: number;
  routeGroupId: string | null;
};

/** What a new category also takes: the key it keeps for good. */
export type NewCategory = CategoryEdit & { key: string };

/**
 * The CHECK `ticket_categories_key_format` in `db/sql/003_constraints.sql`,
 * spelled for JavaScript so the admin reads a sentence before Postgres reads
 * the row. The database still holds the rule: this copy only words it.
 */
const KEY_FORMAT = /^[a-z]+(_[a-z]+)*$/;

/** `position` is a 32-bit integer; Postgres answers anything wider with 22003, out of the action. */
const POSITION_LIMIT = 2_147_483_647;

/**
 * Said when the route group a form named is not there — malformed, or deleted
 * since the page loaded. Exported because the action says it too, for an id it
 * refuses before asking anybody.
 */
export const ROUTE_GROUP_GONE =
  'That group no longer exists — reload the page and pick another route group';

const CATEGORY_GONE = 'That category no longer exists — reload the page and try again';

/**
 * Adds a category, active and not seeded.
 *
 * The key is checked as typed, never tidied into shape: lowercasing
 * `Merchant_Support` would quietly mint a key the admin never saw, and it is
 * the one value they cannot change afterwards.
 *
 * The duplicate check runs twice. Once by reading, so the sentence can name the
 * category that holds the key — and say so when it is retired, because
 * restoring that one is nearly always what was meant. And once by the unique
 * index, through `on conflict do nothing`, for two admins adding the same key
 * at once: a row that came back empty lost that race. That rather than catching
 * 23505, because a unique violation aborts the transaction it is raised in, and
 * the group's lock is held by this one.
 */
export async function createCategory(input: NewCategory): Promise<string | null> {
  const { key } = input;
  if (key === UNKNOWN_CATEGORY_KEY) {
    return '“unknown” is kept for Jev’s answer when a message fits none of the categories, so no category can be called that';
  }
  if (!KEY_FORMAT.test(key)) {
    return 'The key is lowercase words joined by underscores, such as merchant_support';
  }
  const values = editValues(input);
  if (typeof values === 'string') return values;

  return db.transaction(async (tx) => {
    const [taken] = await tx
      .select({ labelEn: ticketCategories.labelEn, isActive: ticketCategories.isActive })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, key))
      .limit(1);
    if (taken) return keyTaken(key, taken);

    const refusal = await holdRouteGroup(tx, values.routeGroupId);
    if (refusal) return refusal;

    const inserted = await tx
      .insert(ticketCategories)
      .values({ key, ...values, isActive: true, isSystem: false })
      .onConflictDoNothing({ target: ticketCategories.key })
      .returning({ id: ticketCategories.id });
    return inserted.length
      ? null
      : `The key ${key} has just been taken — reload the page to see it`;
  });
}

/**
 * Saves an existing category's labels, description, position and route group.
 *
 * Writes nothing when nothing changed: `touch_updated_at` moves `updated_at` on
 * every UPDATE, and a Save pressed on an untouched form would record an edit
 * nobody made.
 */
export async function updateCategory(id: string, input: CategoryEdit): Promise<string | null> {
  const values = editValues(input);
  if (typeof values === 'string') return values;

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        labelEn: ticketCategories.labelEn,
        labelAr: ticketCategories.labelAr,
        description: ticketCategories.description,
        position: ticketCategories.position,
        routeGroupId: ticketCategories.routeGroupId,
      })
      .from(ticketCategories)
      .where(eq(ticketCategories.id, id))
      .for('update');
    if (!current) return CATEGORY_GONE;

    const refusal = await holdRouteGroup(tx, values.routeGroupId);
    if (refusal) return refusal;

    const unchanged = (Object.keys(values) as (keyof typeof values)[]).every(
      (column) => values[column] === current[column],
    );
    if (unchanged) return null;

    await tx.update(ticketCategories).set(values).where(eq(ticketCategories.id, id));
    return null;
  });
}

/**
 * Retires a category, or restores one. Asking for what it already is writes
 * nothing, for the `updated_at` reason above, and is not a refusal: a second
 * tab pressing Retire on a row the first already retired got what it asked for.
 *
 * Tickets already carrying a retired category keep it, and nothing else moves:
 * the ticket's select, a rule's condition and a form's default go on naming it,
 * marked retired. A form defaulting to it opens tickets with no category until
 * an admin picks another or restores this one.
 */
export async function setCategoryActive(id: string, active: boolean): Promise<string | null> {
  const changed = await db
    .update(ticketCategories)
    .set({ isActive: active })
    .where(and(eq(ticketCategories.id, id), ne(ticketCategories.isActive, active)))
    .returning({ id: ticketCategories.id });
  if (changed.length) return null;

  const [exists] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id))
    .limit(1);
  return exists ? null : CATEGORY_GONE;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The columns an edit writes, tidied, or the sentence refusing them.
 *
 * Both labels, always — the subcategories page's rule, for its reason: Arabic is
 * the default locale, and a category is read in both. The CHECK
 * `ticket_categories_labels_not_blank` refuses a blank one too, as an error
 * out of the action rather than a sentence.
 */
function editValues(input: CategoryEdit) {
  const labelEn = input.labelEn.trim();
  const labelAr = input.labelAr.trim();
  if (!labelEn || !labelAr) return 'Both the English and the Arabic label are required';
  if (!Number.isInteger(input.position) || Math.abs(input.position) > POSITION_LIMIT) {
    return 'The position is a small whole number, such as 0 or 10';
  }
  return {
    labelEn,
    labelAr,
    description: input.description.trim() || null,
    position: input.position,
    routeGroupId: input.routeGroupId,
  };
}

/**
 * Key-share locks the route group for the rest of the transaction, or answers
 * that it is gone.
 *
 * Re-read rather than trusted, because the id arrived in a form field. And
 * locked rather than only read: `deleteGroupIfUnused` locks the group's row
 * before it counts what names it, so a delete already holding the lock is
 * waited for and then answered as gone, and one that comes after waits for
 * this write and refuses because the category now names the group. A plain
 * read would let the delete land between the check and the write, where the
 * foreign key would raise 23503 out of the action instead of a sentence.
 */
async function holdRouteGroup(tx: Tx, groupId: string | null): Promise<string | null> {
  if (!groupId) return null;
  const [group] = await tx
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.id, groupId))
    .for('key share');
  return group ? null : ROUTE_GROUP_GONE;
}

function keyTaken(key: string, holder: { labelEn: string; isActive: boolean }): string {
  return holder.isActive
    ? `The key ${key} already belongs to “${holder.labelEn}”`
    : `The key ${key} already belongs to “${holder.labelEn}”, which is retired — restore it rather than adding it again`;
}
