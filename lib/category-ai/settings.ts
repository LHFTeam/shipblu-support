import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import type { Executor } from './runs';
import { agents, categoryAiSettings } from '@/db/schema';
import { logger } from '@/lib/log';
import {
  DEFAULT_MIN_PROBABILITY,
  DEFAULT_ROUTING_WINDOW_MINUTES,
  isCategoryAiMode,
  type CategoryAiMode,
} from './modes';

const log = logger('classify_category');

/**
 * The category classifier's switch, threshold and routing window, as one
 * snapshot.
 *
 * Read on every inbound message stored and by every job, so memoised the way
 * `lib/canned-suggest/settings.ts` memoises its switch: per process, for thirty
 * seconds. The admin who saves sees it at once (`forget` after the save); the
 * worker follows within the TTL, which is also how long switching off — the
 * rollback — takes.
 *
 * One snapshot rather than three reads, so a job never weighs an answer
 * against the threshold of one save and the mode of another.
 *
 * Two readers, CSAT's split (`lib/csat/settings.ts`). The enqueue path, on every
 * stored message, reads the memo; a failed read there reads as off, logged and
 * uncached, so the classifier misses a message rather than breaking the ingest
 * that stored it. Whatever acts on the settings or saves them back — the job,
 * the backfill, the admin page — reads them uncached and lets a failure throw:
 * the page is saved back whole from up to three web instances, so a stale or
 * failed-as-off copy would write `off` over `apply`, and a job that cannot read
 * its switch goes back to the queue rather than guessing it.
 *
 * No row is a fresh install and reads as off, with the defaults
 * `lib/category-ai/modes.ts` names — the same values as the column defaults.
 */

const CACHE_TTL_MS = 30_000;

export type CategoryAiSettings = {
  mode: CategoryAiMode;
  minProbability: number;
  routingWindowMinutes: number;
  /** When it last changed and by whom — null before the first save. */
  changedAt: Date | null;
  changedBy: string | null;
};

const UNSET: CategoryAiSettings = {
  mode: 'off',
  minProbability: DEFAULT_MIN_PROBABILITY,
  routingWindowMinutes: DEFAULT_ROUTING_WINDOW_MINUTES,
  changedAt: null,
  changedBy: null,
};

let cached: { at: number; value: CategoryAiSettings } | null = null;

/**
 * Uncached, and a failed read throws. For the job, the backfill and the admin
 * page — and inside the job's own transaction, where the switch is read again
 * once Jev has answered, so a classifier switched off during the call writes
 * nothing.
 */
export async function readCategoryAiSettings(executor: Executor = db): Promise<CategoryAiSettings> {
  const [row] = await executor
    .select({
      mode: categoryAiSettings.mode,
      minProbability: categoryAiSettings.minProbability,
      routingWindowMinutes: categoryAiSettings.routingWindowMinutes,
      changedAt: categoryAiSettings.updatedAt,
      changedBy: agents.name,
    })
    .from(categoryAiSettings)
    .leftJoin(agents, eq(agents.id, categoryAiSettings.updatedByAgentId))
    .where(eq(categoryAiSettings.id, 1))
    .limit(1);

  // The CHECK in `db/sql/003` holds the mode to the three values, so an
  // unknown one is a database edited past it; reading it as off is the answer
  // that cannot write anything.
  return row ? { ...row, mode: isCategoryAiMode(row.mode) ? row.mode : 'off' } : UNSET;
}

/** Memoised, and a failed read is off. For the enqueue path, on every stored message. */
export async function loadCategoryAiSettings(): Promise<CategoryAiSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const value = await readCategoryAiSettings();
    cached = { at: Date.now(), value };
    return value;
  } catch (error) {
    log.error('could not read the category classifier settings, treating them as off', error);
    return UNSET;
  }
}

/** Drop the memo, so the admin who just saved sees their own change. This process only. */
export function forgetCategoryAiSettings(): void {
  cached = null;
}

/** Write the single row, creating it the first time. The action has already checked the ranges. */
export async function saveCategoryAiSettings(
  values: { mode: CategoryAiMode; minProbability: number; routingWindowMinutes: number },
  updatedByAgentId: string,
): Promise<void> {
  const row = { ...values, updatedByAgentId, updatedAt: new Date() };
  await db
    .insert(categoryAiSettings)
    .values({ id: 1, ...row })
    .onConflictDoUpdate({ target: categoryAiSettings.id, set: row });

  forgetCategoryAiSettings();
}
