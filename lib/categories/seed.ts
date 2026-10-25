import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories } from '@/db/schema';
import { STARTER_CATEGORIES } from './registry';

/**
 * Bringing the category registry up to date with the starter set in code.
 *
 * A reconcile, not an overwrite, for the reason `syncTaxonomy` gives: the code
 * says which categories exist to begin with, and from then on the database says
 * what they are called, in what order, whether they are in use and where they
 * route. So a re-run:
 *
 * - **inserts** a starter category that is missing, found by its key;
 * - **leaves every other column alone** — labels, description, position,
 *   active flag and route group — because an admin edits all of them on
 *   `/admin/categories`, and a seed re-asserting its wording would undo that
 *   edit at the moment nobody is looking;
 * - **never deletes or retires anything**, and reports a seeded row whose key
 *   the code no longer has, so somebody decides.
 *
 * `is_system` is the one column it re-asserts, because it is structural: it
 * says the row came from here.
 *
 * Production runs it by hand (`npm run job -- seed_ticket_categories`), because
 * a deploy runs `db:migrate` and nothing else (`docs/PROJECT-STATE.md` §6.30);
 * `db/baseline.ts` runs it for tests and development.
 */
export type CategorySeedOutcome = {
  created: string[];
  present: number;
  /** Seeded rows whose key the starter set no longer has. */
  orphaned: string[];
};

export async function syncCategories(): Promise<CategorySeedOutcome> {
  const inserted = await db
    .insert(ticketCategories)
    .values(
      STARTER_CATEGORIES.map((category, index) => ({
        key: category.key,
        labelEn: category.labelEn,
        labelAr: category.labelAr,
        description: category.description,
        position: index,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: ticketCategories.key })
    .returning({ key: ticketCategories.key });

  // Only where it is not already true: `touch_updated_at` moves `updated_at`
  // on every UPDATE, written values unchanged or not, and a re-run that
  // re-stamped every row would claim edits nobody made.
  const keys = STARTER_CATEGORIES.map((category) => category.key);
  await db
    .update(ticketCategories)
    .set({ isSystem: true })
    .where(and(inArray(ticketCategories.key, keys), eq(ticketCategories.isSystem, false)));

  const known = new Set(keys);
  const seeded = await db
    .select({ key: ticketCategories.key })
    .from(ticketCategories)
    .where(eq(ticketCategories.isSystem, true));

  return {
    created: inserted.map((row) => row.key),
    present: keys.length - inserted.length,
    orphaned: seeded.map((row) => row.key).filter((key) => !known.has(key)),
  };
}
