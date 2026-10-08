import { and, eq, type SQL, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels } from '@/db/schema';
import { type Coexistence, parseCoexistence, type SyncType } from './coexistence';
import { recordCredentialRefusal } from './credentials';

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

/** A channel connected through coexistence, found by the number Meta names. */
export type CoexistenceChannel = {
  id: string;
  defaultGroupId: string | null;
  whatsappAccountId: string | null;
  coexistence: Coexistence;
};

/**
 * The active WhatsApp channel on `phoneNumberId`, if it was connected through
 * coexistence — or null, for a number that was not, which is a delivery this
 * system has nothing to do with: Meta sends history and contacts for a number
 * only after it was onboarded, so one arriving for another number is a WABA
 * shared with something else.
 */
export async function findCoexistenceChannel(
  phoneNumberId: string | null,
): Promise<CoexistenceChannel | null> {
  if (!phoneNumberId) return null;

  const rows = await db
    .select({
      id: channels.id,
      defaultGroupId: channels.defaultGroupId,
      whatsappAccountId: channels.whatsappAccountId,
      config: channels.config,
    })
    .from(channels)
    .where(
      and(
        eq(channels.type, 'whatsapp'),
        eq(channels.isActive, true),
        sql`${channels.config} ->> 'phoneNumberId' = ${phoneNumberId}`,
      ),
    );

  for (const row of rows) {
    const coexistence = parseCoexistence(row.config);
    if (coexistence) {
      return {
        id: row.id,
        defaultGroupId: row.defaultGroupId,
        whatsappAccountId: row.whatsappAccountId,
        coexistence,
      };
    }
  }
  return null;
}

/**
 * One history chunk processed: count it, and move its phase's progress
 * forward — never back, because chunks arrive in no order (Meta's own words:
 * "chunks can arrive out of order"), and a late chunk at 40% must not undo a
 * phase already at 100%.
 */
export async function recordHistoryProgress(
  channelId: string,
  chunk: { phase: number | null; progress: number | null },
  at: Date,
): Promise<void> {
  const slot = sql`coalesce(${channels.config} #> '{coexistence,syncs,history}', '{}'::jsonb)`;
  const phases = sql`coalesce(${slot} -> 'progressByPhase', '{}'::jsonb)`;

  const progress =
    chunk.phase === null || chunk.progress === null
      ? phases
      : sql`${phases} || jsonb_build_object(
          ${String(chunk.phase)}::text,
          greatest(coalesce((${phases} ->> ${String(chunk.phase)}::text)::int, 0), ${chunk.progress}::int)
        )`;

  const next = sql`${slot} || jsonb_build_object(
    'chunks', coalesce((${slot} ->> 'chunks')::int, 0) + 1,
    'progressByPhase', ${progress},
    'lastReceivedAt', ${at.toISOString()}::text
  )`;

  await updateSlot(channelId, 'history', next);
}

/** The business turned history sharing off on the phone. */
export async function recordHistoryDeclined(
  channelId: string,
  code: number,
  at: Date,
): Promise<void> {
  const slot = sql`coalesce(${channels.config} #> '{coexistence,syncs,history}', '{}'::jsonb)`;
  await updateSlot(
    channelId,
    'history',
    sql`${slot} || jsonb_build_object('declined', jsonb_build_object('at', ${at.toISOString()}::text, 'code', ${code}::int))`,
  );
}

/** One contact received from the phone's address book. */
export async function recordContactSync(channelId: string, at: Date): Promise<void> {
  const slot = sql`coalesce(${channels.config} #> '{coexistence,syncs,contacts}', '{}'::jsonb)`;
  await updateSlot(
    channelId,
    'contacts',
    sql`${slot} || jsonb_build_object(
      'received', coalesce((${slot} ->> 'received')::int, 0) + 1,
      'lastReceivedAt', ${at.toISOString()}::text
    )`,
  );
}

async function updateSlot(channelId: string, type: SyncType, value: SQL): Promise<void> {
  await db
    .update(channels)
    .set({
      config: sql`jsonb_set(${channels.config}, ${syncPath(type)}::text[], ${value}, true)`,
      updatedAt: new Date(),
    })
    .where(
      sql`${channels.id} = ${channelId} and jsonb_typeof(${channels.config} #> '{coexistence,syncs}') = 'object'`,
    );
}

/** Meta's `account_update` events that change what a coexistence number can do. */
const DISCONNECTING = new Set(['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED']);
const RECONNECTING = new Set(['ACCOUNT_RECONNECTED']);

/**
 * Applies an `account_update` to the coexistence channels it is about. Answers
 * how many channels it touched; zero for an event that is not about
 * coexistence, or a WABA with no such channel here.
 *
 * - `PARTNER_REMOVED`: the business disconnected this app from the phone
 *   (Settings → Business Platform → Disconnect), or Meta did — with a reason.
 *   The stored credential no longer reaches the account, so a refusal is
 *   recorded on it, which is what the console's "Reconnect" badge reads.
 * - `ACCOUNT_OFFBOARDED`: the phone changed or the number was registered
 *   again. Meta re-onboards it on its own, usually within minutes, and
 *   Cloud API sends fail meanwhile — so it is badged, and the credential is
 *   left alone: Meta says the partner keeps its access.
 * - `ACCOUNT_RECONNECTED`: that re-onboarding finished. The badge clears;
 *   nothing else changes.
 *
 * Idempotent, because it is not deduplicated at the door (`./delivery-id`
 * says why): the same event applied twice writes the same state twice.
 */
export async function applyWhatsAppAccountUpdate(update: {
  wabaId: string | null;
  phoneNumber: string | null;
  event: string;
  reason: string | null;
  initiatedBy: string | null;
  at: Date;
}): Promise<number> {
  if (!update.wabaId) return 0;
  const disconnecting = DISCONNECTING.has(update.event);
  if (!disconnecting && !RECONNECTING.has(update.event)) return 0;

  const rows = await db
    .select({
      id: channels.id,
      whatsappAccountId: channels.whatsappAccountId,
      config: channels.config,
    })
    .from(channels)
    .where(
      and(
        eq(channels.type, 'whatsapp'),
        sql`${channels.config} #>> '{coexistence,wabaId}' = ${update.wabaId}`,
      ),
    );

  const number = update.phoneNumber?.replace(/\D/g, '') || null;
  const matching = rows.filter((row) => {
    if (!number) return true;
    const known = parseCoexistence(row.config)?.displayPhoneNumber?.replace(/\D/g, '');
    return !known || known === number;
  });

  for (const row of matching) {
    await db
      .update(channels)
      .set({
        config: disconnecting
          ? sql`jsonb_set(${channels.config}, '{coexistence,disconnected}', ${JSON.stringify({
              at: update.at.toISOString(),
              event: update.event,
              reason: update.reason,
              initiatedBy: update.initiatedBy,
            })}::jsonb, true)`
          : sql`${channels.config} #- '{coexistence,disconnected}'`,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, row.id));

    if (update.event === 'PARTNER_REMOVED' && row.whatsappAccountId) {
      const why = [update.reason, update.initiatedBy && `by ${update.initiatedBy.toLowerCase()}`]
        .filter(Boolean)
        .join(', ');
      await recordCredentialRefusal(
        row.whatsappAccountId,
        `Meta reports this number was disconnected from the WhatsApp Business app` +
          `${why ? ` (${why})` : ''}. Reconnect it through Meta to send from it again.`,
      );
    }
  }

  return matching.length;
}
