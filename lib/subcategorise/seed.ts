import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketSubcategories, ticketRootCauses } from '@/db/schema';
import { ROOT_CAUSES, allSubcategories } from './taxonomy';

/**
 * Bringing the registries in the database up to date with the taxonomy in code.
 *
 * The split is the point of the whole design: `taxonomy.ts` owns which
 * subcategories exist, and the database owns what they are called and whether
 * they are still in use. So this is a **reconcile, not an overwrite**.
 *
 * What it does on a re-run:
 *
 * - **Inserts** anything new, at its position from the code.
 * - **Leaves every label alone.** A subcategory renamed by an admin keeps its
 *   name. Re-asserting the seeded label on each deploy would silently undo the
 *   one edit this table exists to allow, and it would do it at the moment
 *   nobody is looking — a deploy.
 * - **Never deletes and never deactivates.** A subcategory with assignments
 *   behind it is retired by an admin, and the FK is `restrict` so a delete
 *   fails loudly rather than orphaning history. A subcategory dropped from the
 *   code is left alone here and reported, so somebody decides.
 *
 * The one thing it does re-assert is `area`, `owner` and `is_system`, because
 * those are structural rather than editorial: a CHECK ties `area` to the key,
 * and `owner` is what every accountability report groups by. Neither is an
 * admin's to change.
 */

export type SeedOutcome = {
  subcategoriesCreated: number;
  subcategoriesPresent: number;
  causesCreated: number;
  causesPresent: number;
  /** In the database, absent from the code — somebody has to decide about these. */
  orphanedSubcategoryKeys: string[];
  orphanedCauseKeys: string[];
};

export async function syncTaxonomy(): Promise<SeedOutcome> {
  const subcategories = allSubcategories();

  const insertedSubcategories = await db
    .insert(ticketSubcategories)
    .values(
      subcategories.map((subcategory) => ({
        key: subcategory.key,
        area: subcategory.area,
        labelEn: subcategory.labelEn,
        labelAr: subcategory.labelAr,
        description: subcategory.note ?? null,
        audience: subcategory.audience,
        isDetectable: !subcategory.manualOnly,
        isSystem: true,
        position: subcategory.position,
      })),
    )
    .onConflictDoNothing({ target: ticketSubcategories.key })
    .returning({ key: ticketSubcategories.key });

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
  for (const subcategory of subcategories) {
    await db
      .update(ticketSubcategories)
      .set({ area: subcategory.area, isSystem: true })
      .where(eq(ticketSubcategories.key, subcategory.key));
  }
  for (const cause of ROOT_CAUSES) {
    await db
      .update(ticketRootCauses)
      .set({ owner: cause.owner, isSystem: true })
      .where(eq(ticketRootCauses.key, cause.key));
  }

  const knownSubcategoryKeys = new Set(subcategories.map((c) => c.key));
  const knownCauseKeys = new Set(ROOT_CAUSES.map((c) => c.key));

  const storedSubcategories = await db
    .select({ key: ticketSubcategories.key })
    .from(ticketSubcategories)
    .where(eq(ticketSubcategories.isSystem, true));
  const storedCauses = await db
    .select({ key: ticketRootCauses.key })
    .from(ticketRootCauses)
    .where(eq(ticketRootCauses.isSystem, true));

  return {
    subcategoriesCreated: insertedSubcategories.length,
    subcategoriesPresent: subcategories.length - insertedSubcategories.length,
    causesCreated: insertedCauses.length,
    causesPresent: ROOT_CAUSES.length - insertedCauses.length,
    orphanedSubcategoryKeys: storedSubcategories
      .map((r) => r.key)
      .filter((k) => !knownSubcategoryKeys.has(k)),
    orphanedCauseKeys: storedCauses.map((r) => r.key).filter((k) => !knownCauseKeys.has(k)),
  };
}

/**
 * How many conversations each subcategory holds — the number that says whether
 * a subcategory is earning its place.
 *
 * Read by the admin screen rather than by the seed. A subcategory at zero after
 * a month is either one nobody needs or a rule that never matches, and only one
 * of those is fine; the distinction is `is_detectable`.
 */
export async function subcategoryUsage(): Promise<Map<string, number>> {
  const rows = await db.execute<{ subcategory_key: string; used: number }>(
    sql`select subcategory_key, count(*)::int as used
        from conversation_subcategories
        where review_state <> 'rejected'
        group by subcategory_key`,
  );

  return new Map(rows.map((row) => [row.subcategory_key, row.used]));
}
