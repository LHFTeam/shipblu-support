import { asc, eq, lt, and, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { shipments } from '@/db/schema';
import { enqueueMany, type ClaimedJob } from '@/lib/queue';
import { stageDisplay } from '@/lib/shipments/status';

/**
 * Finds the parcels nobody has asked the platform about, and asks.
 *
 * The live path has no moment that would do this: `linkShipmentsFromMessage`
 * creates a stub the instant it sees a number and deliberately knows nothing
 * else about it, so without a sweep every shipment stays a bare row forever.
 * This is the query `shipments_sync_idx` was created for — its comment in
 * `db/schema/shipments.ts` reads "a future platform sync job's claim query:
 * everything never synced, oldest first", which is exactly the first half below.
 *
 *     npm run job -- sync_stale_shipments
 *     npm run job -- sync_stale_shipments limit=200
 *     npm run job -- sync_stale_shipments staleMinutes=60
 *
 * It enqueues rather than syncing inline, for the reason `backfill_meta_profiles`
 * does: one parcel the platform chokes on cannot end the run for everybody
 * behind it, the queue's retry and dead-letter handling applies, and the work
 * goes through the very same handler a single sync uses.
 */

type Payload = {
  /** Stop after this many parcels. Absent means all of them. */
  limit?: unknown;
  /**
   * Also re-read parcels synced longer ago than this, in minutes.
   *
   * Absent by default, and that is a decision rather than a gap. How often a
   * moving parcel should be re-read is a question about the platform's rate
   * limits and about how fresh a status has to be, and nobody has answered
   * either — so the cadence is the operator's to set here or in a cron
   * schedule, not one for this file to invent. See PROJECT-STATE §6.
   */
  staleMinutes?: unknown;
};

/** Enough to fill the queue usefully without one run enqueueing a million rows. */
const DEFAULT_LIMIT = 500;

export async function syncStaleShipments(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const limit =
    typeof payload.limit === 'number' && payload.limit > 0 ? payload.limit : DEFAULT_LIMIT;
  const staleMinutes =
    typeof payload.staleMinutes === 'number' && payload.staleMinutes > 0
      ? payload.staleMinutes
      : null;

  // Never asked about, oldest first — straight down `shipments_sync_idx`.
  const stubs = await db
    .select({ id: shipments.id, trackingNumber: shipments.trackingNumber })
    .from(shipments)
    .where(eq(shipments.syncState, 'stub'))
    .orderBy(asc(shipments.createdAt))
    .limit(limit);

  const stale = staleMinutes ? await staleRows(staleMinutes, limit - stubs.length) : [];

  const candidates = [...stubs, ...stale];
  if (candidates.length === 0) {
    console.log('[sync_stale_shipments] nothing to sync');
    return;
  }

  const enqueued = await enqueueMany(
    'sync_shipment',
    // `force` because the sweep has already decided this row is due; without it
    // the handler's own freshness guard would discard everything the stale half
    // of this run just selected.
    candidates.map((row) => ({ shipmentId: row.id, force: true })),
    // Behind anything a customer is waiting on. A sweep of the whole archive
    // must never sit in front of an outbound reply.
    { priority: 200 },
  );

  console.log(
    `[sync_stale_shipments] enqueued ${enqueued} (${stubs.length} never synced, ` +
      `${stale.length} stale${staleMinutes ? ` over ${staleMinutes}m` : ''})`,
  );
}

/**
 * Synced parcels that have gone quiet, minus the ones that are finished.
 *
 * The terminal filter is applied here in TypeScript rather than in the `WHERE`
 * clause, and it has to be: "finished" is `stageDisplay(...).terminal`, a
 * keyword reading of free text that recognises `delivered`, `Delivered` and
 * `تم التسليم` alike. Expressing that as SQL would mean a second copy of the
 * keyword table living in a string — the two would drift, and the direction they
 * drift in is a delivered parcel being re-read forever.
 */
async function staleRows(staleMinutes: number, room: number) {
  if (room <= 0) return [];

  const cutoff = new Date(Date.now() - staleMinutes * 60_000);

  const rows = await db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      statusLabel: shipments.statusLabel,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.syncState, 'synced'),
        isNotNull(shipments.lastSyncedAt),
        lt(shipments.lastSyncedAt, cutoff),
      ),
    )
    .orderBy(asc(shipments.lastSyncedAt))
    // Over-fetch, because the terminal ones are filtered out below and a
    // database full of delivered parcels would otherwise return a page of them
    // and report nothing to do.
    .limit(room * 4);

  return rows.filter((row) => !stageDisplay(row.statusLabel).terminal).slice(0, room);
}
