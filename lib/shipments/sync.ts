import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { shipments } from '@/db/schema';
import { normaliseTrackingNumber } from './format';
import {
  fetchCurrentEstimatedDate,
  fetchDeliveryOrder,
  ShipbluApiError,
  type DeliveryOrder,
  type FetchOptions,
} from './platform';
import { stageDisplay } from './status';

/**
 * Bringing one shipment up to date with the delivery platform.
 *
 * One implementation, and — following `lib/meta/profile-refresh.ts`, which is
 * the precedent this deliberately copies — the *decisions* live here while the
 * *reaction* lives with the caller. The `sync_shipment` job turns `transient`
 * into a rethrow so the queue retries it; a console button would turn the same
 * value into a sentence under itself. AGENTS.md requires that shape: the two
 * paths must not be able to answer differently about the same parcel.
 *
 * ## What this writes, and what it refuses to
 *
 * It writes `status_label`, `status_at`, `sync_state`, `last_synced_at` and the
 * whole response into `data`. It does **not** write `shipper_contact_id` or
 * `recipient_contact_id`, even though the payload names a customer with an email
 * and a phone number and matching one to a contact would be four lines.
 * `plans/shipment-customer-tracking.md` §9 rules that out in advance and it is
 * still right: shared household phones, call-centre numbers and merchants using
 * their own number make it the most dangerous guess available, and this endpoint
 * hands the same details to anyone holding a tracking number, so a match here
 * would let an outsider's guess attach a name to one of our contacts.
 *
 * It also leaves `shipping_account_id` alone. The payload carries `merchant.id`,
 * and it is *plausible* that it is the SBID — 7550 is the right shape — but
 * nobody has confirmed it, and a wrong link would file a parcel under another
 * merchant's account. That is a question for the shipping team, not an
 * inference; see PROJECT-STATE §6.
 */

/**
 * How long a sync stays good enough.
 *
 * The freshness guard exists because there are three ways to ask for one — the
 * job, a sweep, and eventually a button — and a parcel checked twice in a minute
 * has not moved. Anything wanting a genuinely current read passes `force`.
 */
export const SYNC_TTL_MS = 5 * 60_000;

export type ShipmentSyncResult =
  /** No such row: deleted, or the id was stale by the time the job ran. */
  | { kind: 'gone' }
  /** Synced recently enough, and the caller did not insist. */
  | { kind: 'skipped'; lastSyncedAt: Date | null }
  /** The platform is certain it has no such parcel. Recorded, not retried. */
  | { kind: 'not_found' }
  /** Worth another attempt. Only the caller knows whether there will be one. */
  | { kind: 'transient'; error: ShipbluApiError }
  /** Permanently wrong — a bad request, an unreadable body. Never stamped. */
  | { kind: 'refused'; error: ShipbluApiError }
  | {
      kind: 'synced';
      order: DeliveryOrder;
      /**
       * The freshest estimate, when one was asked for and answered. Null both
       * when the parcel has arrived — nothing is estimated any more — and when
       * the second call failed, which is why the log line distinguishes them.
       */
      currentEstimatedDate: string | null;
    };

export async function syncShipment(input: {
  /** Either identifies the parcel; the row is re-read whichever is given. */
  shipmentId?: string;
  trackingNumber?: string;
  /** Ignore the freshness guard. The sweep and any manual control set it. */
  force?: boolean;
  /**
   * Shortens the platform round trip, for a caller somebody is waiting on.
   *
   * The default suits a queue, where ten seconds costs nothing and a slow answer
   * still beats no answer. A page render is the opposite case: the customer is
   * looking at a blank screen, and a stored status shown quickly is worth more
   * than a current one shown late.
   */
  timeoutMs?: number;
}): Promise<ShipmentSyncResult> {
  const row = await findShipment(input);
  if (!row) return { kind: 'gone' };

  // Re-read rather than trusting the payload: a job can sit in the queue while
  // another worker syncs the same parcel, and the row is the only thing that
  // knows whether that already happened.
  if (!input.force && row.lastSyncedAt && Date.now() - row.lastSyncedAt.getTime() < SYNC_TTL_MS) {
    return { kind: 'skipped', lastSyncedAt: row.lastSyncedAt };
  }

  let order: DeliveryOrder | null;
  try {
    order = await fetchDeliveryOrder(row.trackingNumber, { timeoutMs: input.timeoutMs });
  } catch (error) {
    if (!(error instanceof ShipbluApiError)) throw error;
    return error.isTransient ? { kind: 'transient', error } : { kind: 'refused', error };
  }

  if (!order) {
    /*
     * `not_found` is a fact worth storing, not merely the absence of one: it is
     * what tells the tracking page to stop saying "no status yet" about a number
     * that will never have one, and what stops a sweep re-asking about a typo
     * forever.
     *
     * `last_synced_at` is stamped too, deliberately — without it the freshness
     * guard above cannot see this attempt, and every sweep would ask again.
     */
    await db
      .update(shipments)
      .set({ syncState: 'not_found', lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(shipments.id, row.id));
    return { kind: 'not_found' };
  }

  const currentEstimatedDate = await currentEstimateFor(order, { timeoutMs: input.timeoutMs });

  const now = new Date();
  await db
    .update(shipments)
    .set({
      // The platform's own word, stored verbatim. `shipments.status_label` is
      // free text precisely so an ops rename is not an `ALTER TYPE`; reading it
      // into one of our own stages is a *display* concern and belongs to
      // `status.ts`, which never writes anything back.
      statusLabel: order.status,
      statusAt: order.statusAt,
      platformOrderId: order.platformId,
      currentEstimatedDate,
      syncState: 'synced',
      lastSyncedAt: now,
      data: order.raw,
      updatedAt: now,
    })
    .where(eq(shipments.id, row.id));

  return { kind: 'synced', order, currentEstimatedDate };
}

/**
 * The second call, and the rules about when it is worth making.
 *
 * **Never fails the sync.** The delivery order is the thing the tracking page
 * cannot render without; a refreshed estimate is an improvement on it. Letting
 * the second call throw would mean a platform hiccup on an enhancement discarded
 * a status we had already successfully read.
 *
 * **Not asked for a parcel that has arrived.** The endpoint keeps answering for
 * a delivered parcel, and answers with a date in the *future* — on the parcel
 * this was built against, delivered on the 30th, it still reports the 31st. That
 * is worse than no answer: it is a wrong answer that looks authoritative. So a
 * terminal parcel stores null, which also means the column empties when a parcel
 * lands rather than keeping the last guess made before it did.
 *
 * **The echoed tracking number is checked.** The endpoint returns the parcel it
 * thinks the id belongs to; if that is not the parcel we asked about, the id we
 * stored is wrong and the safe move is to record no estimate rather than to put
 * another parcel's date on this one.
 */
export async function currentEstimateFor(
  order: DeliveryOrder,
  options: FetchOptions = {},
): Promise<string | null> {
  if (stageDisplay(order.status).terminal) return null;

  try {
    const estimate = await fetchCurrentEstimatedDate(order.platformId, options);
    if (!estimate) return null;

    if (estimate.trackingNumber && estimate.trackingNumber !== order.trackingNumber) {
      console.error(
        `[shipments] order ${order.platformId} answers for ${estimate.trackingNumber}, not ` +
          `${order.trackingNumber} — not storing an estimate`,
      );
      return null;
    }

    return estimate.date;
  } catch (error) {
    console.warn(
      `[shipments] could not read the current estimate for ${order.trackingNumber}: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return null;
  }
}

async function findShipment(input: { shipmentId?: string; trackingNumber?: string }) {
  const columns = {
    id: shipments.id,
    trackingNumber: shipments.trackingNumber,
    lastSyncedAt: shipments.lastSyncedAt,
  };

  if (input.shipmentId) {
    const rows = await db
      .select(columns)
      .from(shipments)
      .where(eq(shipments.id, input.shipmentId))
      .limit(1);
    return rows[0] ?? null;
  }

  const canonical = normaliseTrackingNumber(input.trackingNumber ?? '');
  if (!canonical) return null;

  const rows = await db
    .select(columns)
    .from(shipments)
    .where(eq(shipments.trackingNumber, canonical))
    .limit(1);
  return rows[0] ?? null;
}

/** One line an operator can read, for the job's log and any future button. */
export function describeShipmentSync(result: ShipmentSyncResult): string {
  switch (result.kind) {
    case 'gone':
      return 'no longer exists';
    case 'skipped':
      return `synced recently${result.lastSyncedAt ? ` (${result.lastSyncedAt.toISOString()})` : ''}, skipped`;
    case 'not_found':
      return 'the platform has no such parcel';
    case 'transient':
      return `could not be read this time: ${result.error.message}`;
    case 'refused':
      return `refused: ${result.error.message}`;
    case 'synced':
      return (
        `${result.order.status}` +
        `${result.order.statusAt ? ` at ${result.order.statusAt.toISOString()}` : ''}` +
        ` (${result.order.events.length} events` +
        `${result.currentEstimatedDate ? `, due ${result.currentEstimatedDate}` : ''})`
      );
  }
}
