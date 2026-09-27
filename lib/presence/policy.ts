import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { presencePolicy } from '@/db/schema';
import { DEFAULT_POLICY, type PresencePolicy, type StoredPresencePolicy } from './idle';
import { logger } from '@/lib/log';

const log = logger('presence');

/**
 * Reading the idle policy, cheaply enough to do it on every request.
 *
 * `getSessionAgent()` consults it on every page load and every server action —
 * it is where the sign-out is actually enforced — so an uncached read would add
 * a round trip to every request in the console for two integers that change a
 * few times a year.
 *
 * Hence the memo. It is deliberately short: an admin editing the window watches
 * it take effect, and the sweep is the backstop for anything that slips through
 * a stale copy. Per-process, so a fleet of three instances converges within the
 * TTL rather than instantly, which is the trade this cache is.
 *
 * The row may not exist. That is the resting state of a fresh install rather
 * than an error, and it reads as `DEFAULT_POLICY` — the numbers live in exactly
 * one place, so a seed row and a constant can never drift apart. Once the row
 * exists it is authoritative in both directions, including a null meaning
 * "somebody turned this timer off".
 */

const CACHE_TTL_MS = 30_000;

let cached: { at: number; value: StoredPresencePolicy } | null = null;

/** No row yet is a fresh install: the defaults, and nothing to grant a grace against. */
const UNSET: StoredPresencePolicy = { ...DEFAULT_POLICY, changedAt: null };

export async function loadPresencePolicy(): Promise<StoredPresencePolicy> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const rows = await db
      .select({
        autoAwayAfterMins: presencePolicy.autoAwayAfterMins,
        autoSignoutAfterMins: presencePolicy.autoSignoutAfterMins,
        // Read as `changedAt`, because that is what it is used for: the grace
        // period a just-enabled window grants the whole fleet.
        changedAt: presencePolicy.updatedAt,
      })
      .from(presencePolicy)
      .where(eq(presencePolicy.id, 1))
      .limit(1);

    cached = { at: Date.now(), value: rows[0] ?? UNSET };
  } catch (error) {
    // Never the reason a page fails to render. A database that cannot answer
    // this is about to fail the page's real queries anyway, and falling back to
    // the defaults keeps the failure to the thing that actually broke.
    //
    // Not cached, so the next request tries again rather than serving defaults
    // for the next thirty seconds.
    log.error('could not read the idle policy, using defaults', error);
    return UNSET;
  }

  return cached.value;
}

/**
 * Drop the memo after a write, so the admin who just saved sees their own change.
 *
 * Only this process. The others fall in line within the TTL, which is why the
 * TTL is seconds rather than minutes.
 */
export function forgetPresencePolicy(): void {
  cached = null;
}

/** Write the single row, creating it the first time. */
export async function savePresencePolicy(
  policy: PresencePolicy,
  updatedByAgentId: string,
): Promise<void> {
  await db
    .insert(presencePolicy)
    .values({ id: 1, ...policy, updatedByAgentId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: presencePolicy.id,
      set: { ...policy, updatedByAgentId, updatedAt: new Date() },
    });

  forgetPresencePolicy();
}
