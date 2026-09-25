import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories } from '@/db/schema';
import type { CategoryOption } from './request';

/**
 * The vocabulary both detectors answer over, read from the registry.
 *
 * `is_active` and `is_detectable` are the same two predicates `apply.ts` applies
 * when it resolves a rule's key to a row, so a category retired or marked
 * undetectable in the console stops being an option here at the same moment it
 * stops being one there. Reading `TAXONOMY` instead would be simpler and would
 * quietly reintroduce the drift: the model would keep offering a category the
 * rules can no longer assign, and every disagreement on it would be an artefact.
 *
 * Ordered by the taxonomy's own position so the `criteria` map is built in a
 * stable order — two runs of the same corpus should differ because the model
 * differed, not because a request was serialised differently.
 */
export async function categoryOptionsForAi(): Promise<CategoryOption[]> {
  const rows = await db
    .select({
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      description: ticketCategories.description,
    })
    .from(ticketCategories)
    .where(and(eq(ticketCategories.isActive, true), eq(ticketCategories.isDetectable, true)))
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));

  return rows;
}
