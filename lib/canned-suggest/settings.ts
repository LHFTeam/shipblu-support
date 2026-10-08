import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, cannedSuggestionSettings } from '@/db/schema';
import { logger } from '@/lib/log';
import { typesafeConfigured } from '@/lib/typesafe/client';

const log = logger('canned_suggest');

/**
 * Whether the reply composer asks Jev for a canned response.
 *
 * Read on every ticket page and on every suggestion request, so it is memoised
 * the way `lib/presence/policy.ts` memoises the idle policy: per process, for
 * thirty seconds. An admin who flips it watches it take effect for themselves at
 * once (`forget` after the save) and for the rest of the fleet within the TTL.
 * Switching off is the rollback, so thirty seconds is also how long the rollback
 * takes; it is short for that reason.
 *
 * No row is a fresh install and reads as off. A failed read also reads as off,
 * uncached, so the next request tries again: this is an optional feature, and a
 * database that cannot answer it is about to fail the page's real queries
 * anyway.
 */

const CACHE_TTL_MS = 30_000;

export type SuggestionSettings = {
  enabled: boolean;
  /** When it last changed and by whom — null before the first save. */
  changedAt: Date | null;
  changedBy: string | null;
};

const UNSET: SuggestionSettings = { enabled: false, changedAt: null, changedBy: null };

let cached: { at: number; value: SuggestionSettings } | null = null;

export async function loadSuggestionSettings(): Promise<SuggestionSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const rows = await db
      .select({
        enabled: cannedSuggestionSettings.enabled,
        changedAt: cannedSuggestionSettings.updatedAt,
        changedBy: agents.name,
      })
      .from(cannedSuggestionSettings)
      .leftJoin(agents, eq(agents.id, cannedSuggestionSettings.updatedByAgentId))
      .where(eq(cannedSuggestionSettings.id, 1))
      .limit(1);

    cached = { at: Date.now(), value: rows[0] ?? UNSET };
  } catch (error) {
    log.error('could not read the suggestion switch, treating it as off', error);
    return UNSET;
  }

  return cached.value;
}

/** Drop the memo, so the admin who just saved sees their own change. This process only. */
export function forgetSuggestionSettings(): void {
  cached = null;
}

/** Write the single row, creating it the first time. */
export async function saveSuggestionSettings(
  enabled: boolean,
  updatedByAgentId: string,
): Promise<void> {
  await db
    .insert(cannedSuggestionSettings)
    .values({ id: 1, enabled, updatedByAgentId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: cannedSuggestionSettings.id,
      set: { enabled, updatedByAgentId, updatedAt: new Date() },
    });

  forgetSuggestionSettings();
}

/**
 * Whether a suggestion can be asked for right now: switched on, and a key to ask
 * with. The key alone is not enough — production holds one for the shadow
 * categoriser — and the switch alone is not either, because an environment with
 * no key would otherwise show agents a feature that can only ever say nothing.
 */
export async function suggestionsLive(): Promise<boolean> {
  return typesafeConfigured() && (await loadSuggestionSettings()).enabled;
}
