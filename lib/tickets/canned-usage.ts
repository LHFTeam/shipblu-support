import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { logger } from '@/lib/log';
import type { CannedLocale } from './canned';

const log = logger('canned');

type UsageColumn = 'usageCount' | 'usageCountAr' | 'usageCountEn';

/**
 * The column that counts a use in each language.
 *
 * A record over `CannedLocale` so that a third locale stops this compiling,
 * rather than being counted in the total and nowhere else without anybody
 * noticing.
 */
const LOCALE_COLUMN = {
  ar: 'usageCountAr',
  en: 'usageCountEn',
} as const satisfies Record<CannedLocale, UsageColumn>;

/**
 * Records that an agent sent a reply carrying a canned response, and in which
 * language.
 *
 * Agents only. An automation rule's `send_reply` sends the same response to
 * every ticket it matches, and counting those would rank one rule's volume
 * above everything the team chose by hand — so `sendCannedReply` deliberately
 * does not call this. Here rather than in the action file so the database tier
 * can run the statement, which nothing else does before production.
 *
 * After the send rather than before it: the column ranks what the team actually
 * sends, so a reply that failed validation and never left must not count. The
 * id comes from the composer, so it is incremented rather than trusted for
 * anything — an id that matches nothing updates no rows, which is the whole
 * blast radius. The language is the same: whatever the composer says it
 * inserted, or null when it did not say, in which case only the total moves.
 *
 * One statement, so the total and the language's own count cannot disagree
 * about whether a use happened.
 *
 * It never throws. A lost increment costs a ranking column one point, and
 * failing an agent's reply, which has already been stored and queued, because
 * a counter did not move would be the wrong trade.
 */
export async function recordCannedUse(id: string, locale: CannedLocale | null): Promise<void> {
  const increment: Partial<Record<UsageColumn, SQL>> = {
    usageCount: sql`${cannedResponses.usageCount} + 1`,
  };
  if (locale) {
    const column = LOCALE_COLUMN[locale];
    increment[column] = sql`${cannedResponses[column]} + 1`;
  }

  try {
    await db.update(cannedResponses).set(increment).where(eq(cannedResponses.id, id));
  } catch (error) {
    log.warn('could not record a use', error);
  }
}
