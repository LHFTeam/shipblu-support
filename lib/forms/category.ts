import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketForms } from '@/db/schema';
import { CATEGORY_REFUSALS, checkCategory } from '@/lib/categories/write';
import { NO_CATEGORY } from '@/lib/categories/choices';
import { canonicalUuid } from '@/lib/http/uuid';

/**
 * The two places a person names a category for a ticket a form opens: an
 * admin setting a form's default, and an agent choosing one on the console's
 * New form. Here rather than in the action files so a `*.db.test.ts` reaches
 * both, and both answer in the ticket sidebar's sentences, `CATEGORY_REFUSALS`.
 *
 * Neither writes anything. The category itself is written by `createTicket`,
 * inside the transaction that opens the ticket, which reads the registry again
 * under a share lock — these refuse early, with a sentence, what that write
 * would otherwise leave off in silence.
 */

/**
 * Whether a form may be saved defaulting to this category, or the sentence
 * refusing it.
 *
 * Unlocked, and that is enough: a retire landing between this answer and the
 * save leaves the rows a save followed by a retire leaves, and a form whose
 * default was retired after it was saved is a state the editor and creation
 * already handle. A ticket is different — its `category_changed` would date the
 * category after the retire — which is why `createTicket` holds it.
 *
 * A retired category is refused as a new choice, and kept when it is what the
 * form already holds: the editor names a retired default "(retired)" and posts
 * it back, so a save that only fixed a typo in the intro must not fail over a
 * category an admin retired since — the same rule a rule's condition follows.
 * Creation leaves a retired default off the ticket, so keeping it changes no
 * ticket. Null clears the default.
 */
export async function formDefaultCategoryRefusal(
  formId: string | null,
  categoryId: string | null,
): Promise<string | null> {
  if (!categoryId) return null;
  const checked = await checkCategory(categoryId);
  if (checked === 'unknown_category') return CATEGORY_REFUSALS.unknown_category;
  if (checked !== 'retired_category') return null;

  if (!formId) return CATEGORY_REFUSALS.retired_category;
  const [form] = await db
    .select({ defaultCategoryId: ticketForms.defaultCategoryId })
    .from(ticketForms)
    .where(eq(ticketForms.id, formId))
    .limit(1);
  // In the column's spelling, which is lower case whatever was posted.
  return form?.defaultCategoryId === canonicalUuid(categoryId)
    ? null
    : CATEGORY_REFUSALS.retired_category;
}

/**
 * What the console's chooser asks for, as `submitForm`'s agent requester
 * carries it, or the sentence refusing it.
 *
 * - `''` — left on the form's default: `undefined`, so the form's choice is
 *   recorded as the form's.
 * - `none` — no category: `null`.
 * - an id — that category, re-read here because it arrived in a form field.
 *
 * Anything but `''` from an agent without `ticket.set_category` is refused: the
 * page draws no chooser for them, so a value is a request the page did not
 * offer. Called before the requester is resolved, because resolving inserts a
 * contact for a new address, and a refusal after that would leave one behind.
 */
export async function consoleCategoryChoice(
  raw: string,
  canSet: boolean,
): Promise<{ categoryId: string | null | undefined } | { error: string }> {
  if (!raw) return { categoryId: undefined };
  if (!canSet) return { error: "You cannot set a ticket's category" };
  if (raw === NO_CATEGORY) return { categoryId: null };
  const checked = await checkCategory(raw);
  if (typeof checked === 'string') return { error: CATEGORY_REFUSALS[checked] };
  return { categoryId: checked.id };
}
