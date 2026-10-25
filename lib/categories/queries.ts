import { cache } from 'react';
import { asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, ticketCategories } from '@/db/schema';

/** One row of the registry, as every picker and the admin page read it. */
export type CategoryRow = {
  id: string;
  key: string;
  labelEn: string;
  labelAr: string;
  description: string | null;
  position: number;
  isActive: boolean;
  isSystem: boolean;
  routeGroupId: string | null;
};

/**
 * Every category, retired ones included, in the order an admin set.
 *
 * Retired rows come back too because each reader needs them for a different
 * reason: the admin page restores them, the ticket's select and a rule's
 * condition still have to name one a ticket or a rule already holds, and the
 * inbox's filter has to say what a stale link filters on. Each picker offers
 * only the active ones for a new choice.
 *
 * Memoised for the request, like `inboxCounts`: the ticket page reads it for
 * the sidebar and the inbox shell around it reads it for the filter, and the
 * two would otherwise be two queries for one four-row table on every render.
 */
export const listCategories = cache(async (): Promise<CategoryRow[]> => {
  return db
    .select({
      id: ticketCategories.id,
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      labelAr: ticketCategories.labelAr,
      description: ticketCategories.description,
      position: ticketCategories.position,
      isActive: ticketCategories.isActive,
      isSystem: ticketCategories.isSystem,
      routeGroupId: ticketCategories.routeGroupId,
    })
    .from(ticketCategories)
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));
});

/**
 * How many live tickets carry each category — what the admin page shows beside
 * Retire, so an admin can see what a category has behind it.
 */
export async function categoryUsage(): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: conversations.categoryId, count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(sql`${conversations.categoryId} is not null and ${conversations.deletedAt} is null`)
    .groupBy(conversations.categoryId);
  return new Map(rows.map((row) => [row.id!, row.count]));
}
