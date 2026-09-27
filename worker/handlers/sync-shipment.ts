import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { describeShipmentSync, syncShipment } from '@/lib/shipments/sync';

/**
 * Fills in one parcel's real status from the delivery platform.
 *
 * A job rather than a call inside ingest, for the reason AGENTS.md gives: a
 * customer's ticket must never depend on `api.shipblu.com` being up. The
 * detector's stub is created and the message becomes a ticket whether or not
 * this ever succeeds.
 *
 * Enqueued **without a `dedupeKey`**, and that is not an oversight. `jobs_dedupe_idx`
 * is a plain unique index over the whole table, so a key is spent for good —
 * keying on a shipment would mean each parcel could be synced exactly once in
 * the life of the database, and every later attempt would silently collapse onto
 * a row that finished months ago. AGENTS.md names this trap and names the way
 * out: make the handler idempotent and enqueue without a key. `syncShipment` is
 * idempotent — it re-reads the row, writes the same columns, and has its own
 * freshness guard for the case this runs twice in a moment.
 *
 *     npm run job -- sync_shipment trackingNumber=1755021358719
 *     npm run job -- sync_shipment shipmentId=<uuid> force=true
 */

export async function syncShipmentJob(job: ClaimedJob): Promise<void> {
  // The tracking number arrives as a string whichever way it was enqueued; the
  // schema says why a number is accepted too.
  const { shipmentId, trackingNumber, force } = parseJobPayload(job, 'sync_shipment');

  const result = await syncShipment({ shipmentId, trackingNumber, force: force === true });

  const subject = shipmentId ?? trackingNumber;
  const line = `[sync_shipment] ${subject} → ${describeShipmentSync(result)}`;

  if (result.kind === 'refused') console.error(line);
  else if (result.kind === 'transient' || result.kind === 'gone') console.warn(line);
  else console.log(line);

  // The one reaction a queue can have and a person watching a page cannot.
  // Thrown after everything durable is written, so a retry only re-reads.
  if (result.kind === 'transient') throw result.error;
}
