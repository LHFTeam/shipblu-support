import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketCategories } from '@/db/schema';
import type { CategoryOption } from './request';

/**
 * The categories Jev may choose between: the active rows of
 * `ticket_categories`, in the order the console lists them.
 *
 * Read from the registry at the time of asking, never from the starter set in
 * code, for the rule `AGENTS.md` sets the subcategoriser: a category an admin
 * retires leaves the question the moment it leaves the console, and an edited
 * label or description is the question from the next message on — which is why
 * the live job reads this per job rather than through a memo, so one cached
 * window cannot mix two questions under one fingerprint.
 *
 * Not `listCategories`, which is wrapped in React's `cache` for a page and
 * returns retired rows too.
 */
export async function categoryOptionsForAi(): Promise<CategoryOption[]> {
  return db
    .select({
      id: ticketCategories.id,
      key: ticketCategories.key,
      labelEn: ticketCategories.labelEn,
      description: ticketCategories.description,
    })
    .from(ticketCategories)
    .where(eq(ticketCategories.isActive, true))
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));
}
