import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import type { Coexistence, SyncType } from './coexistence';

/**
 * The one writer of a channel's `coexistence` object, after the onboarding job
 * creates it.
 *
 * Every write is a single `jsonb_set` on the column rather than a read, an edit
 * in JavaScript and a write back. The history Meta sends after a sync request
 * arrives as many webhooks processed concurrently, each moving a counter in the
 * same object; a read-modify-write would have them overwrite each other's
 * progress, and the badge would go backwards. One statement each, and the row
 * lock Postgres takes for the update, is what keeps them all.
 *
 * Paths are built from fixed vocabularies (`SyncType`), never from input, and
 * bound as `text[]` parameters.
 */

type Executor = typeof db;

/** `{coexistence,syncs,<type>}`, as the text[] Postgres takes for a jsonb path. */
function syncPath(type: SyncType): string {
  return `{coexistence,syncs,${type}}`;
}

/**
 * Writes the whole object for a channel that has just been connected — or
 * reconnected, which starts it over: a fresh `onboardedAt` opens a fresh copy
 * window, the old requests are gone with the old connection, and a disconnect
 * recorded before it no longer applies.
 */
export async function writeOnboardedCoexistence(
  executor: Executor,
  channelId: string,
  coexistence: Coexistence,
): Promise<void> {
  await executor
    .update(channels)
    .set({
      config: sql`jsonb_set(${channels.config}, '{coexistence}', ${JSON.stringify(coexistence)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId));
}

export type SyncOutcome = { requestId: string } | { error: string };

/**
 * What came of asking Meta for a number's contacts or history.
 *
 * Merged into the slot rather than replacing it: the first history webhook can
 * be processed before this write lands, and its progress must survive. A
 * success clears an earlier refusal from the slot; a refusal never overwrites a
 * request that already succeeded — the button that retries refuses first, so
 * that is only a concurrent double-click, and the request id is the fact that
 * matters.
 *
 * A no-op for a channel without a `coexistence` object, which is a channel this
 * was never for.
 */
export async function recordSyncRequest(
  channelId: string,
  type: SyncType,
  outcome: SyncOutcome,
  at: Date,
): Promise<void> {
  const path = syncPath(type);
  const instant = at.toISOString();

  const patch =
    'requestId' in outcome
      ? { requestId: outcome.requestId, requestedAt: instant }
      : { error: outcome.error.slice(0, 500), attemptedAt: instant };

  const merged =
    'requestId' in outcome
      ? sql`(coalesce(${channels.config} #> ${path}::text[], '{}'::jsonb) - 'error' - 'attemptedAt') || ${JSON.stringify(patch)}::jsonb`
      : sql`case when (${channels.config} #> ${path}::text[]) ? 'requestId'
               then ${channels.config} #> ${path}::text[]
               else coalesce(${channels.config} #> ${path}::text[], '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
             end`;

  await db
    .update(channels)
    .set({
      config: sql`jsonb_set(${channels.config}, ${path}::text[], ${merged}, true)`,
      updatedAt: new Date(),
    })
    .where(
      sql`${channels.id} = ${channelId} and jsonb_typeof(${channels.config} -> 'coexistence') = 'object'
          and jsonb_typeof(${channels.config} #> '{coexistence,syncs}') = 'object'`,
    );
}
