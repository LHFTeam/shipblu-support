import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';
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

/**
 * The `config` and account link an admin's save of a `whatsapp` channel writes
 * — decided by Postgres inside the UPDATE, not from a read the action took
 * before it.
 *
 * A channel carrying a `coexistence` object keeps its whole `config` and its
 * account exactly as the row holds them; any other takes the form's phone
 * number id and account. Both are kept rather than rebuilt because nothing in
 * them is the form's to change: the phone number id is what Meta reported, the
 * object is moved by concurrent webhooks and the job, and the account is the
 * one whose credential this connection was made with — sending from another
 * is the "went out from the wrong WABA" failure `./accounts` describes.
 *
 * In the statement rather than in the action because the action's read is
 * stale by the time it writes. Copying `config` from that read wrote back a
 * snapshot over every `jsonb_set` that landed in between — a history chunk's
 * progress, a request id, a disconnection — which is the read-modify-write
 * this module exists to avoid; and a channel the onboarding job adopted in
 * between would have lost its connection and been pointed back at its old
 * account. Under READ COMMITTED an UPDATE that waits on a concurrent writer
 * evaluates its SET again against the row it then locks, so the CASE sees the
 * object as it is when the write happens.
 */
export function whatsappEditColumns(form: {
  phoneNumberId: string;
  whatsappAccountId: string | null;
}): { config: SQL; whatsappAccountId: SQL } {
  const connected = sql`jsonb_typeof(${channels.config} -> 'coexistence') = 'object'`;
  return {
    config: sql`case when ${connected} then ${channels.config}
                     else ${JSON.stringify({ phoneNumberId: form.phoneNumberId })}::jsonb end`,
    whatsappAccountId: sql`case when ${connected} then ${channels.whatsappAccountId}
                                else ${form.whatsappAccountId}::uuid end`,
  };
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

/**
 * `count` address-book entries applied from one delivery: added to the
 * counter in one write, rather than one per entry — a phone with 5,000
 * contacts would otherwise be 5,000 updates of this row. One when not given,
 * for a caller holding a single entry.
 *
 * It counts entries applied, not distinct people: an entry Meta sends again,
 * or an edit the phone sends later, is counted again. Distinct counting would
 * need a per-number record that does not belong in this jsonb.
 */
export async function recordContactSync(channelId: string, at: Date, count = 1): Promise<void> {
  if (count <= 0) return;
  const slot = sql`coalesce(${channels.config} #> '{coexistence,syncs,contacts}', '{}'::jsonb)`;
  await updateSlot(
    channelId,
    'contacts',
    sql`${slot} || jsonb_build_object(
      'received', coalesce((${slot} ->> 'received')::int, 0) + ${count}::int,
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
 * how many channels it changed; zero for an event that is not about
 * coexistence, a WABA with no such channel here, or an event older than the
 * state it would overwrite.
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
 * **Applied in the order the events happened, not the order they are
 * processed.** Deliveries are processed in no order (`docs/PROJECT-STATE.md`
 * §6.77), and each of these overwrites the last: a late `ACCOUNT_RECONNECTED`
 * from an earlier offboarding would clear a newer `PARTNER_REMOVED` and stop
 * offering Reconnect while the credential is gone; a late `ACCOUNT_OFFBOARDED`
 * would badge a number that has since come back; and a `PARTNER_REMOVED` about
 * the connection before a reconnect would badge the new one and refuse its
 * fresh credential. So an event is applied only when it is at least as new as
 * the connection (`onboardedAt`, the exchange) and as the last event applied
 * to it (`accountEventAt`, a high-water mark kept beside the badge — the badge
 * itself cannot be the mark, because `ACCOUNT_RECONNECTED` deletes it and
 * leaves a late `ACCOUNT_OFFBOARDED` nothing to compare against). Both are
 * compared in the UPDATE, against the row as it is when the write lands: two
 * deliveries run concurrently, and a check in JavaScript between the read
 * and the write would let the older one land second. A reconnect writes the
 * whole object again (`writeOnboardedCoexistence`), which resets the mark.
 *
 * Meta's `entry.time` is whole seconds, so `onboardedAt` is compared at that
 * precision; two events in the same second fall back to processing order,
 * which nothing can improve on. `<=` rather than `<` keeps it idempotent —
 * it is not deduplicated at the door (`./delivery-id` says why), and the same
 * event applied twice writes the same state twice.
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
  if (matching.length === 0) return 0;

  // Bound as text behind `::timestamptz`: a bare Date in a `sql` template
  // reaches postgres.js untyped (AGENTS.md, Tests).
  const instant = update.at.toISOString();
  const marked = disconnecting
    ? sql`jsonb_set(${channels.config}, '{coexistence,disconnected}', ${JSON.stringify({
        at: instant,
        event: update.event,
        reason: update.reason,
        initiatedBy: update.initiatedBy,
      })}::jsonb, true)`
    : sql`(${channels.config} #- '{coexistence,disconnected}')`;

  const applied = await db
    .update(channels)
    .set({
      config: sql`jsonb_set(${marked}, '{coexistence,accountEventAt}', ${JSON.stringify(instant)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(
          channels.id,
          matching.map((row) => row.id),
        ),
        // Again here: a reconnect to another WABA between the read and this
        // write leaves the row about a different account.
        sql`${channels.config} #>> '{coexistence,wabaId}' = ${update.wabaId}`,
        sql`date_trunc('second', (${channels.config} #>> '{coexistence,onboardedAt}')::timestamptz) <= ${instant}::timestamptz`,
        sql`coalesce((${channels.config} #>> '{coexistence,accountEventAt}')::timestamptz, '-infinity') <= ${instant}::timestamptz`,
      ),
    )
    .returning({ id: channels.id, whatsappAccountId: channels.whatsappAccountId });

  if (update.event === 'PARTNER_REMOVED') {
    await refuseCredentialsOlderThan(
      new Set(applied.flatMap((row) => (row.whatsappAccountId ? [row.whatsappAccountId] : []))),
      update,
    );
  }

  return applied.length;
}

/**
 * The credential half of `PARTNER_REMOVED`: a refusal on each account whose
 * credential the event can be about.
 *
 * Only for channels the event was applied to, and only for a credential stored
 * no later than the event. The channel's guard is not enough on its own: a
 * reconnect stores the new token in the action, and the job that writes the
 * new `onboardedAt` runs after it — so a stale `PARTNER_REMOVED` processed in
 * that gap still passes the channel's guard, and without this would refuse the
 * credential the business has just granted. The comparison is
 * `recordCredentialRefusal`'s, made under its lock on the credential, so a
 * reconnect committing while this runs is seen rather than refused; an
 * account with no stored credential is a no-op there, since a variable or the
 * shared token is somebody else's to rotate.
 */
async function refuseCredentialsOlderThan(
  accountIds: Set<string>,
  update: { reason: string | null; initiatedBy: string | null; at: Date },
): Promise<void> {
  const why = [update.reason, update.initiatedBy && `by ${update.initiatedBy.toLowerCase()}`]
    .filter(Boolean)
    .join(', ');
  const sentence =
    `Meta reports this number was disconnected from the WhatsApp Business app` +
    `${why ? ` (${why})` : ''}. Reconnect it through Meta to send from it again.`;

  for (const accountId of accountIds) {
    await recordCredentialRefusal(accountId, sentence, update.at);
  }
}
