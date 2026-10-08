import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { logger } from '@/lib/log';
import { resolveLocale, type BilingualBody, type CannedLocale } from './canned';
import { cannedVisibleTo } from './lookups';

const log = logger('canned');

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
} as const satisfies Record<CannedLocale, 'usageCountAr' | 'usageCountEn'>;

/**
 * What one use moves. The total is a required key, not a `Partial` entry, so an
 * edit that dropped it would stop compiling rather than quietly stop counting
 * the column the split is a breakdown of.
 */
type Increment = { usageCount: SQL } & Partial<Record<(typeof LOCALE_COLUMN)[CannedLocale], SQL>>;

/** A use that was counted: the response, and the language it went out in. */
export type CannedUse = {
  id: string;
  title: string;
  /** Null when the composer did not say, and only the total moved. */
  locale: CannedLocale | null;
  bodies: BilingualBody;
};

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
 * sends, so a reply that failed validation and never left must not count.
 *
 * Both the id and the language arrive in the reply's form, so neither is
 * trusted. The row is re-read through `cannedVisibleTo`, the rule the
 * composer's list is built from, so a posted id for somebody else's personal
 * response, or a team's this agent is not on, counts nothing. And the language
 * is put through `resolveLocale` against the bodies just read, exactly as the
 * composer chose it, so a use can only land in a language the response is
 * written in. `wanted` is null when the composer did not say — a console tab
 * rendered before it sent one — and then only the total moves.
 *
 * The total and the language move in one statement, so they cannot disagree
 * about whether a use happened.
 *
 * It never throws. A lost increment costs a ranking column one point, and
 * failing an agent's reply, which has already been stored and queued, because
 * a counter did not move would be the wrong trade.
 *
 * It answers with the response it counted, or null for none — so the one read
 * that decided this was a real, visible use is also what a canned suggestion's
 * outcome is scored against (`lib/canned-suggest/outcome.ts`), rather than a
 * second read that could disagree with it about the same reply.
 */
export async function recordCannedUse(
  agentId: string,
  id: string,
  wanted: CannedLocale | null,
): Promise<CannedUse | null> {
  try {
    const [response] = await db
      .select({
        id: cannedResponses.id,
        title: cannedResponses.title,
        ar: cannedResponses.bodyTextAr,
        en: cannedResponses.bodyTextEn,
      })
      .from(cannedResponses)
      .where(and(eq(cannedResponses.id, id), cannedVisibleTo(agentId)))
      .limit(1);

    // Deleted since the composer rendered, or never this agent's to use.
    if (!response) return null;

    const increment: Increment = { usageCount: sql`${cannedResponses.usageCount} + 1` };
    const locale = wanted ? resolveLocale(response, wanted) : null;
    if (locale) {
      const column = LOCALE_COLUMN[locale];
      increment[column] = sql`${cannedResponses[column]} + 1`;
    }

    await db.update(cannedResponses).set(increment).where(eq(cannedResponses.id, id));
    // The id as the database spells it, so a grade comparing it with a stored
    // choice is not thrown by the case of a uuid a form posted.
    return {
      id: response.id,
      title: response.title,
      locale,
      bodies: { ar: response.ar, en: response.en },
    };
  } catch (error) {
    log.warn('could not record a use', error);
    return null;
  }
}
