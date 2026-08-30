import { z } from 'zod';
import { env } from '@/lib/env';
import { normaliseTrackingNumber } from './format';

/**
 * Reading a parcel's real status off the ShipBlu delivery platform.
 *
 * This is the seam `plans/shipment-customer-tracking.md` §7 designed and left
 * unbuilt, and its absence is why `/help/<locale>/track` has never been able to
 * answer anything: the detector creates a stub the moment it sees a number, and
 * until now nothing in this system ever wrote `shipments.status_label`. One
 * public endpoint closes that:
 *
 *     GET https://api.shipblu.com/api/v1/delivery-order/<tracking_number>/
 *
 * Two halves, deliberately split. `mapDeliveryOrder` is pure and gets the tests;
 * `fetchDeliveryOrder` is the round trip and gets the timeout and the error
 * taxonomy. The write lives in `sync.ts`, so a caller that only wants to read
 * cannot accidentally stamp a row.
 *
 * ## What the endpoint actually is, which is not what its URL suggests
 *
 * It takes a `?pin=` parameter, and **the pin is not checked**. An empty pin, a
 * wrong pin and no pin at all return byte-identical responses, and the body
 * carries the recipient's full name, email address, phone number, street
 * address, GPS coordinates and the cash-on-delivery amount. So the tracking
 * number is the only credential, and everything here is written on the
 * assumption that anyone holding one can already read all of it.
 *
 * That is a fact about the platform, not about this module, and it is why
 * `sync.ts` writes the payload only to `shipments.data` — a column no public
 * page selects. `getShipmentByTrackingNumber` returns a `ShipmentDetail` whose
 * field list does not include `data`, which is what keeps the customer-facing
 * tracking page showing a status and a stepper rather than somebody's address.
 * Widening that type is the change that would leak this; do not.
 */

/** Where the platform lives when `SHIPBLU_API_URL` says nothing. */
export const DEFAULT_SHIPBLU_API_URL = 'https://api.shipblu.com';

/** Long enough for a slow round trip, short enough that a worker slot frees. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export class ShipbluApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Whether another attempt could plausibly answer differently. */
    readonly isTransient: boolean,
  ) {
    super(message);
    this.name = 'ShipbluApiError';
  }
}

/** One entry of the platform's own history for a parcel. */
export type TrackingEvent = {
  /** The platform's word, untranslated — `out_for_delivery`, `en_route`. */
  status: string;
  at: Date;
  comment: string | null;
};

export type DeliveryOrder = {
  /** Canonicalised, so it can be compared to what we asked for. */
  trackingNumber: string;
  /** The platform's own row id, as a string. Informational; we key on the number. */
  platformId: string;
  /** The current status, in the platform's vocabulary. Stored verbatim. */
  status: string;
  /** When the current status happened — see `statusInstant` for the rule. */
  statusAt: Date | null;
  /** Every event, oldest first. The endpoint does **not** send them in order. */
  events: TrackingEvent[];
  merchantName: string | null;
  /**
   * Calendar dates, kept as the `YYYY-MM-DD` strings they arrive as.
   *
   * Deliberately never parsed into a `Date`. These carry no time and no offset,
   * so `new Date('2026-08-29')` would fix them to midnight **UTC** — which is
   * 02:00 in Cairo, and renders as the day before for anyone displaying them in
   * a westward zone. A calendar date is not an instant; the moment one becomes a
   * `Date` the bug is already written.
   */
  estimatedDate: string | null;
  preferredDate: string | null;
  /**
   * The response exactly as it arrived, for `shipments.data`.
   *
   * Carried alongside the mapping rather than re-fetched or re-serialised so the
   * stored copy and the columns derived from it can never describe two different
   * reads of the same parcel.
   */
  raw: Record<string, unknown>;
};

/**
 * The fields we map, and nothing more.
 *
 * Not `.strict()`, on purpose: the platform is free to add fields and none of
 * them should be able to fail a sync. Everything unmapped still reaches the
 * database — `sync.ts` stores the untouched response in `shipments.data` — so
 * this schema's job is only to say what we are willing to *read*.
 *
 * The scalar unions are not defensiveness for its own sake. `tracking_number`
 * comes back as a JSON string today while `id` comes back as a number, and both
 * are the same kind of identifier; pinning either to one JSON type would make a
 * harmless serialisation change on their side a hard failure on ours.
 */
const trackingEventSchema = z.object({
  status: z.string(),
  created: z.string(),
  comment: z.string().nullish(),
});

const deliveryOrderSchema = z.object({
  id: z.union([z.number(), z.string()]),
  tracking_number: z.union([z.number(), z.string()]),
  status: z.string(),
  merchant: z
    .object({
      name: z.string().nullish(),
      display_name: z.string().nullish(),
    })
    .nullish(),
  tracking_events: z.array(trackingEventSchema).nullish(),
  estimated_date: z.string().nullish(),
  preferred_date: z.string().nullish(),
});

/**
 * The response, read into the shape this system stores.
 *
 * Throws `ShipbluApiError` on a body that is not a delivery order at all, which
 * the caller treats as permanent: a malformed payload will be malformed again on
 * the retry, and a queue that keeps asking only delays somebody noticing.
 */
export function mapDeliveryOrder(raw: unknown): DeliveryOrder {
  const parsed = deliveryOrderSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ShipbluApiError(`Delivery order response did not parse: ${issues}`, null, false);
  }

  const order = parsed.data;
  const events = readEvents(order.tracking_events ?? []);

  return {
    trackingNumber: normaliseTrackingNumber(String(order.tracking_number)),
    platformId: String(order.id),
    status: order.status,
    statusAt: statusInstant(order.status, events),
    events,
    // `display_name` is what the merchant chose to be called; `name` is the
    // account's own. Prefer the former where they differ, which is the string a
    // human would recognise on a ticket.
    merchantName: order.merchant?.display_name ?? order.merchant?.name ?? null,
    estimatedDate: order.estimated_date ?? null,
    preferredDate: order.preferred_date ?? null,
    // Safe by construction: the schema above only accepts an object, so anything
    // reaching here parsed as one.
    raw: raw as Record<string, unknown>,
  };
}

/**
 * Every event with a real instant on it, oldest first.
 *
 * **The endpoint returns these in no order whatsoever.** The live response for
 * 1755021358719 opens with an `en_route` from the 30th, puts `delivered` third,
 * and carries `created` — the very first thing that happened — last of ten. So
 * `events[0]` and `events.at(-1)` are both meaningless, and any code that reads
 * either is reading an arbitrary row. Sorting here, once, is what stops that
 * from being rediscovered by every consumer.
 *
 * An unparseable timestamp drops the event rather than failing the sync: one bad
 * row in a history is not a reason to leave a customer with no status at all.
 */
function readEvents(rows: z.infer<typeof trackingEventSchema>[]): TrackingEvent[] {
  const events: TrackingEvent[] = [];

  for (const row of rows) {
    const at = new Date(row.created);
    if (Number.isNaN(at.getTime())) continue;
    events.push({ status: row.status, at, comment: row.comment ?? null });
  }

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * When the current status happened.
 *
 * The newest event that *matches the current status*, not simply the newest
 * event. `status_label` and `status_at` are written as a pair and read as one
 * sentence — the tracking page renders "Delivered" directly above the timestamp
 * — so a rule that let them come from different rows would print a status with
 * somebody else's clock next to it. Falls back to the newest event, then to
 * nothing at all, because a label with no time under it is honest and a label
 * with the wrong time is not.
 */
function statusInstant(status: string, events: TrackingEvent[]): Date | null {
  const canonical = status.trim().toLowerCase();

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.status.trim().toLowerCase() === canonical) return events[i]!.at;
  }

  return events.at(-1)?.at ?? null;
}

export type FetchOptions = {
  /** Overridden by tests and by nothing else. */
  baseUrl?: string;
  timeoutMs?: number;
};

/**
 * Ask the platform about one tracking number.
 *
 * `null` means the platform is certain it has no such parcel — a 404, which is
 * a definite answer and is recorded as `not_found` rather than retried. Anything
 * else throws, and `isTransient` says whether asking again could help.
 *
 * No `?pin=`: the parameter exists in the documented URL and the endpoint does
 * not check it (see the file docstring), so sending one would suggest a
 * protection that is not there.
 */
export async function fetchDeliveryOrder(
  trackingNumber: string,
  options: FetchOptions = {},
): Promise<DeliveryOrder | null> {
  const canonical = normaliseTrackingNumber(trackingNumber);
  if (!canonical) throw new ShipbluApiError('No tracking number to look up', null, false);

  const base = (options.baseUrl ?? env().SHIPBLU_API_URL ?? DEFAULT_SHIPBLU_API_URL).replace(
    /\/+$/,
    '',
  );
  const url = `${base}/api/v1/delivery-order/${encodeURIComponent(canonical)}/`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout, a DNS failure, a reset connection. None of these is an answer,
    // so none of them may be allowed to stamp `not_found` on a real parcel.
    throw new ShipbluApiError(
      `Could not reach the delivery platform: ${error instanceof Error ? error.message : error}`,
      null,
      true,
    );
  }

  if (response.status === 404) return null;

  if (!response.ok) {
    // 429 and 5xx are the platform asking for a moment; the rest is us asking
    // wrongly, and will be just as wrong on the next attempt.
    const isTransient = response.status === 429 || response.status >= 500;
    throw new ShipbluApiError(
      `Delivery platform returned ${response.status} for ${canonical}`,
      response.status,
      isTransient,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A 200 carrying something that is not JSON is a proxy or a captive portal
    // answering instead of the platform. Worth another try.
    throw new ShipbluApiError(
      `Delivery platform returned a 200 that was not JSON for ${canonical}`,
      response.status,
      true,
    );
  }

  return mapDeliveryOrder(body);
}
