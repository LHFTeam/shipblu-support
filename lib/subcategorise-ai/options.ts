import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketSubcategories } from '@/db/schema';
import type { SubcategoryOption } from './request';

/**
 * The vocabulary both detectors answer over, read from the registry.
 *
 * `is_active` and `is_detectable` are the same two predicates `apply.ts` applies
 * when it resolves a rule's key to a row, so a subcategory retired or marked
 * undetectable in the console stops being an option here at the same moment it
 * stops being one there. Reading `TAXONOMY` instead would be simpler and would
 * quietly reintroduce the drift: the model would keep offering a subcategory the
 * rules can no longer assign, and every disagreement on it would be an artefact.
 *
 * Ordered by the taxonomy's own position so the `criteria` map is built in a
 * stable order — two runs of the same corpus should differ because the model
 * differed, not because a request was serialised differently.
 */
export async function subcategoryOptionsForAi(): Promise<SubcategoryOption[]> {
  const rows = await db
    .select({
      key: ticketSubcategories.key,
      labelEn: ticketSubcategories.labelEn,
      description: ticketSubcategories.description,
    })
    .from(ticketSubcategories)
    .where(and(eq(ticketSubcategories.isActive, true), eq(ticketSubcategories.isDetectable, true)))
    .orderBy(asc(ticketSubcategories.position), asc(ticketSubcategories.key));

  return rows;
}
