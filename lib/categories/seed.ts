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
 *   the code no longer has, so somebody decides;
 * - **reports a starter key an admin's own category holds**, and leaves it
 *   theirs. Web is live before anybody runs the seed, and the empty admin page
 *   offers "add one here", so `sales` can exist with an admin's wording first.
 *
 * `is_system` says the row came from here, so only the insert writes it. It
 * once re-asserted the flag on every starter key, and the only row that could
 * change was such an admin's: it became "seeded", and a later starter set
 * without that key would have reported it as an orphan the seed never wrote.
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
  /** Starter keys an admin's own category holds, so the seed left them alone. */
  heldByAdmin: string[];
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

  const keys = STARTER_CATEGORIES.map((category) => category.key);
  const known = new Set(keys);
  const rows = await db
    .select({ key: ticketCategories.key, isSystem: ticketCategories.isSystem })
    .from(ticketCategories);

  return {
    created: inserted.map((row) => row.key),
    present: keys.length - inserted.length,
    orphaned: rows.filter((row) => row.isSystem && !known.has(row.key)).map((row) => row.key),
    heldByAdmin: rows.filter((row) => !row.isSystem && known.has(row.key)).map((row) => row.key),
  };
}
