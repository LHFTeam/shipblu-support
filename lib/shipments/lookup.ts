import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { shipments } from '@/db/schema';
import {
  agentTracking,
  publicTracking,
  storedReturn,
  type AgentTracking,
  type PublicTracking,
} from './detail';
import { normaliseTrackingNumber } from './format';
import { fetchDeliveryOrder } from './platform';
import { currentEstimateFor, syncShipment } from './sync';

/**
 * Answering "where is my parcel" for somebody who is not signed in.
 *
 * The public tracking page is the one place in this system where an
 * unauthenticated request can cause an outbound call to another company's API,
 * so the shape of this function is mostly about what it refuses to do.
 *
 * **It never creates a row.** A number nobody has ever raised a ticket about is
 * read straight from the platform and rendered, and nothing is written. The
 * obvious alternative — upsert a stub, sync it, render it — would hand anyone
 * walking the thirteen-digit number space a way to fill `shipments` with rows,
 * one anonymous GET each, and a helpdesk has no use for a parcel that no
 * conversation mentions. So the write path stays where a person put the number
 * there on purpose: the detector, and an agent typing one into a ticket.
 *
 * **It never throws.** Every failure — a timeout, a 500, a malformed body —
 * falls back to whatever is stored, and a shipment with nothing stored falls
 * back to the page's "no delivery status yet". The page's one job when the
 * platform is down is to still render.
 *
 * **It is a read-through cache, not a refresh.** Where a row exists the sync
 * runs unforced, so `SYNC_TTL_MS` decides whether the platform is called at all
 * and a reloading customer costs one round trip every five minutes rather than
 * one per keystroke. The rate limit on the page is the other half of that and is
 * not a substitute for it: the limit is per address, the TTL is per parcel.
 */

/**
 * Shorter than the queue's, because a person is watching this one.
 *
 * Four seconds is about the point where a customer on a phone decides the page
 * is broken. Past it, a stored status — even a stale one — is the better answer,
 * and the sweep will bring the row up to date without anybody waiting.
 */
export const PUBLIC_LOOKUP_TIMEOUT_MS = 4_000;

export async function publicTrackingFor(trackingNumber: string): Promise<PublicTracking | null> {
  const canonical = normaliseTrackingNumber(trackingNumber);
  if (!canonical) return null;

  const rows = await db
    .select({
      id: shipments.id,
      data: shipments.data,
      currentEstimatedDate: shipments.currentEstimatedDate,
      syncState: shipments.syncState,
    })
    .from(shipments)
    .where(eq(shipments.trackingNumber, canonical))
    .limit(1);

  const row = rows[0];

  if (!row) return await readThrough(canonical);

  /*
   * A parcel the platform has already denied is not asked about again.
   *
   * `not_found` is a durable answer — a typo does not become a real number —
   * and re-asking on every page load would turn one mistyped digit in a popular
   * ticket into an unbounded stream of 404s at somebody else's API.
   */
  if (row.syncState === 'not_found') return null;

  const result = await syncShipment({
    shipmentId: row.id,
    timeoutMs: PUBLIC_LOOKUP_TIMEOUT_MS,
  });

  // The freshly written payload where the sync ran, the stored one where the TTL
  // said not to bother or the platform could not be reached.
  if (result.kind === 'synced') {
    return publicTracking(result.order.raw, result.currentEstimatedDate);
  }
  if (result.kind === 'not_found') return null;

  return publicTracking(row.data, row.currentEstimatedDate);
}

/**
 * A number this system has never seen, read without writing anything.
 *
 * Deliberately not shared with the branch above: that one has a row to update
 * and a `sync_state` to set, this one must leave no trace at all, and folding
 * them together is how the no-write rule would eventually be lost.
 */
async function readThrough(canonical: string): Promise<PublicTracking | null> {
  try {
    const order = await fetchDeliveryOrder(canonical, { timeoutMs: PUBLIC_LOOKUP_TIMEOUT_MS });
    if (!order) return null;

    /*
     * The second call, on the anonymous path too — a number this system has
     * never seen still deserves today's estimate rather than the one it was
     * booked with. Through the same `currentEstimateFor` the stored path uses,
     * so the skip-when-delivered rule and the echoed-tracking-number check
     * cannot come out differently depending on whether a ticket happens to
     * mention the parcel. It never throws, and it costs nothing for a delivered
     * parcel, which is the majority of what gets looked up.
     */
    const estimate = await currentEstimateFor(order, { timeoutMs: PUBLIC_LOOKUP_TIMEOUT_MS });
    return publicTracking(order.raw, estimate);
  } catch (error) {
    // Logged rather than surfaced: the customer gets the page's ordinary "no
    // status yet", which is true from where they are standing, and the operator
    // gets the reason.
    console.warn(
      `[track] could not read ${canonical} from the platform: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return null;
  }
}

/**
 * The stored payload for the console, with the details a public page may not
 * show.
 *
 * A read and nothing else — no platform call, no write. The console has an
 * explicit refresh control for that, and a page that silently synced on every
 * view would make an agent's "checked 4d ago" untrue the moment they looked at
 * it, which is the one fact that control exists to give them.
 *
 * Separate from `getShipmentByTrackingNumber` rather than folded into it,
 * because `ShipmentDetail` must not grow a `data` field: the public tracking
 * page selects that type, and the day it carries the raw payload is the day the
 * recipient's address is one careless `{...shipment}` away from being published
 * (`docs/PROJECT-STATE.md` §6.38).
 */
export async function agentTrackingFor(trackingNumber: string): Promise<AgentTracking | null> {
  const canonical = normaliseTrackingNumber(trackingNumber);
  if (!canonical) return null;

  const rows = await db
    .select({ data: shipments.data, currentEstimatedDate: shipments.currentEstimatedDate })
    .from(shipments)
    .where(eq(shipments.trackingNumber, canonical))
    .limit(1);

  return rows[0] ? agentTracking(rows[0].data, rows[0].currentEstimatedDate) : null;
}

/**
 * Which of these parcels are going back, and how far along each is.
 *
 * Here rather than in `queries.ts` because selecting `shipments.data` is
 * confined to this module and `detail.ts` — the console's ticket sidebar needs
 * the answer, not the payload, and a `select` on that column in a list query is
 * how the confinement erodes. `scripts/ci/repo-rules.mjs` enforces it, and
 * AGENTS.md is explicit that the fix is to move the call rather than add it to
 * the exemption list.
 *
 * One round trip for the whole list rather than one each. The sidebar loads a
 * handful of parcels, but a list query that grows a per-row query is the shape
 * that stops being free without anybody noticing.
 *
 * Absent from the map means "not going back", which is the common case — the
 * caller reads a miss as null rather than having to hold every id.
 */
export async function returnsForShipments(
  shipmentIds: readonly string[],
): Promise<Map<string, NonNullable<ReturnType<typeof storedReturn>>>> {
  const found = new Map<string, NonNullable<ReturnType<typeof storedReturn>>>();
  if (shipmentIds.length === 0) return found;

  const rows = await db
    .select({ id: shipments.id, data: shipments.data })
    .from(shipments)
    .where(inArray(shipments.id, [...shipmentIds]));

  for (const row of rows) {
    const progress = storedReturn(row.data);
    if (progress) found.set(row.id, progress);
  }

  return found;
}
