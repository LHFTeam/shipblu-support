import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories, ticketRootCauses } from '@/db/schema';
import { ROOT_CAUSES, allCategories } from './taxonomy';

/**
 * Bringing the registries in the database up to date with the taxonomy in code.
 *
 * The split is the point of the whole design: `taxonomy.ts` owns which
 * categories exist, and the database owns what they are called and whether they
 * are still in use. So this is a **reconcile, not an overwrite**.
 *
 * What it does on a re-run:
 *
 * - **Inserts** anything new, at its position from the code.
 * - **Leaves every label alone.** A category renamed by an admin keeps its
 *   name. Re-asserting the seeded label on each deploy would silently undo the
 *   one edit this table exists to allow, and it would do it at the moment
 *   nobody is looking — a deploy.
 * - **Never deletes and never deactivates.** A category with assignments behind
 *   it is retired by an admin, and the FK is `restrict` so a delete fails loudly
 *   rather than orphaning history. A category dropped from the code is left
 *   alone here and reported, so somebody decides.
 *
 * The one thing it does re-assert is `area`, `owner` and `is_system`, because
 * those are structural rather than editorial: a CHECK ties `area` to the key,
 * and `owner` is what every accountability report groups by. Neither is an
 * admin's to change.
 */

export type SeedOutcome = {
  categoriesCreated: number;
  categoriesPresent: number;
  causesCreated: number;
  causesPresent: number;
  /** In the database, absent from the code — somebody has to decide about these. */
  orphanedCategoryKeys: string[];
  orphanedCauseKeys: string[];
};

export async function syncTaxonomy(): Promise<SeedOutcome> {
  const categories = allCategories();

  const insertedCategories = await db
    .insert(ticketCategories)
    .values(
      categories.map((category) => ({
        key: category.key,
        area: category.area,
        labelEn: category.labelEn,
        labelAr: category.labelAr,
        description: category.note ?? null,
        audience: category.audience,
        isDetectable: !category.manualOnly,
        isSystem: true,
        position: category.position,
      })),
    )
    .onConflictDoNothing({ target: ticketCategories.key })
    .returning({ key: ticketCategories.key });

  const insertedCauses = await db
    .insert(ticketRootCauses)
    .values(
      ROOT_CAUSES.map((cause, index) => ({
        key: cause.key,
        labelEn: cause.labelEn,
        labelAr: cause.labelAr,
        description: cause.note ?? null,
        owner: cause.owner,
        isSystem: true,
        position: index,
      })),
    )
    .onConflictDoNothing({ target: ticketRootCauses.key })
    .returning({ key: ticketRootCauses.key });

  // Structural columns, re-asserted. Not the labels — see the docstring.
  for (const category of categories) {
    await db
      .update(ticketCategories)
      .set({ area: category.area, isSystem: true })
      .where(eq(ticketCategories.key, category.key));
  }
  for (const cause of ROOT_CAUSES) {
    await db
      .update(ticketRootCauses)
      .set({ owner: cause.owner, isSystem: true })
      .where(eq(ticketRootCauses.key, cause.key));
  }

  const knownCategoryKeys = new Set(categories.map((c) => c.key));
  const knownCauseKeys = new Set(ROOT_CAUSES.map((c) => c.key));

  const storedCategories = await db
    .select({ key: ticketCategories.key })
    .from(ticketCategories)
    .where(eq(ticketCategories.isSystem, true));
  const storedCauses = await db
    .select({ key: ticketRootCauses.key })
    .from(ticketRootCauses)
    .where(eq(ticketRootCauses.isSystem, true));

  return {
    categoriesCreated: insertedCategories.length,
    categoriesPresent: categories.length - insertedCategories.length,
    causesCreated: insertedCauses.length,
    causesPresent: ROOT_CAUSES.length - insertedCauses.length,
    orphanedCategoryKeys: storedCategories
      .map((r) => r.key)
      .filter((k) => !knownCategoryKeys.has(k)),
    orphanedCauseKeys: storedCauses.map((r) => r.key).filter((k) => !knownCauseKeys.has(k)),
  };
}

/**
 * How many conversations each category holds — the number that says whether a
 * category is earning its place.
 *
 * Read by the admin screen rather than by the seed. A category at zero after a
 * month is either one nobody needs or a rule that never matches, and only one of
 * those is fine; the distinction is `is_detectable`.
 */
export async function categoryUsage(): Promise<Map<string, number>> {
  const rows = await db.execute<{ category_key: string; used: number }>(
    sql`select category_key, count(*)::int as used
        from conversation_categories
        where review_state <> 'rejected'
        group by category_key`,
  );

  return new Map(rows.map((row) => [row.category_key, row.used]));
}
