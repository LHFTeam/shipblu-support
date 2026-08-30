import { z } from 'zod';
import { mapDeliveryOrder, type TrackingEvent } from './platform';

/**
 * Reading a stored delivery-order payload back out, for a named audience.
 *
 * `shipments.data` holds the platform's response untouched, and that response
 * carries the recipient's name, email, phone, street address, GPS coordinates
 * and the cash-on-delivery amount (`docs/PROJECT-STATE.md` §6.38). Two very
 * different screens read it: a public page anybody holding a tracking number can
 * open, and a console only a signed-in agent reaches.
 *
 * **This is the only module that reads that column**, and it never returns what
 * it was given. Both functions below build a fresh object out of an explicit
 * list of fields — no spread, no passthrough, no `Partial<Raw>` — so the public
 * shape cannot grow a personal detail by accident when the platform adds a
 * field. That property is the whole point of the file: the alternative, letting
 * each page pick its own fields off `data`, means the privacy promise is only as
 * good as the newest page, and `/help/<locale>/track` makes that promise in
 * writing (`trackPrivacyNote`).
 *
 * The ordering and status-dating rules are not repeated here. `mapDeliveryOrder`
 * already owns them — including the one that matters most, that the platform
 * sends `tracking_events` in no order at all — and a second implementation
 * reading the same payload is exactly how two screens start disagreeing about
 * when a parcel was delivered.
 */

/** What the public tracking page may show. Every field here is safe by review. */
export type PublicTracking = {
  trackingNumber: string;
  /** The platform's own word. Never translated, never rewritten. */
  status: string;
  statusAt: Date | null;
  /** Oldest first. The history a recipient is entitled to see. */
  events: TrackingEvent[];
  /** A calendar date, kept as a string — never an instant. */
  estimatedDate: string | null;
};

/**
 * What an agent may additionally see.
 *
 * Everything the platform hands out, because an agent on a call needs to verify
 * who they are speaking to and answer a question about the money. This is not a
 * widening of who can read the data — the endpoint gives all of it to anyone
 * with the number — it is the difference between a page that requires a session
 * and one that does not.
 */
export type AgentTracking = PublicTracking & {
  platformId: string | null;
  merchantName: string | null;
  merchantPhone: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  /** The written address, in the order it is written. Empty when unknown. */
  addressLines: string[];
  zone: string | null;
  city: string | null;
  governorate: string | null;
  /** Cash to collect on delivery, in EGP. */
  codAmount: number | null;
  preferredDate: string | null;
  deliveredAt: Date | null;
  pickedUpAt: Date | null;
};

/**
 * The fields only an agent sees, read leniently.
 *
 * Separate from the schema in `platform.ts` because the two answer different
 * questions: that one says what a *sync* needs in order to write its columns and
 * must stay small, this one says what a *screen* may draw. Every field is
 * optional — a stored payload can predate any of them, and a missing address is
 * a blank line rather than a failed page.
 */
const agentFieldsSchema = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  merchant: z
    .object({
      name: z.string().nullish(),
      display_name: z.string().nullish(),
      store_phone: z.string().nullish(),
    })
    .nullish(),
  customer: z
    .object({
      full_name: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      phone: z.string().nullish(),
      secondary_phone: z.string().nullish(),
      email: z.string().nullish(),
      address: z
        .object({
          line_1: z.string().nullish(),
          line_2: z.string().nullish(),
          line_3: z.string().nullish(),
          zone: z
            .object({
              name: z.string().nullish(),
              city: z
                .object({
                  name: z.string().nullish(),
                  governorate: z.object({ name: z.string().nullish() }).nullish(),
                })
                .nullish(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  cash_amount: z.union([z.number(), z.string()]).nullish(),
  preferred_date: z.string().nullish(),
  delivered_date: z.string().nullish(),
  pickup_date: z.string().nullish(),
});

/**
 * A stored payload, or null when there is not one worth reading.
 *
 * `shipments.data` defaults to `{}` for every stub, so "empty" is the ordinary
 * case rather than an error, and a payload written by an older shape of this
 * code must degrade to "nothing to show" instead of taking the page down with
 * it. The tracking page has exactly one job on the day something goes wrong,
 * which is to still render.
 */
function readPayload(data: unknown): ReturnType<typeof mapDeliveryOrder> | null {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return null;

  try {
    return mapDeliveryOrder(data);
  } catch {
    return null;
  }
}

export function publicTracking(data: unknown): PublicTracking | null {
  const order = readPayload(data);
  if (!order) return null;

  // Built field by field. Never `...order` — that would carry `raw`, and `raw`
  // is the entire payload.
  return {
    trackingNumber: order.trackingNumber,
    status: order.status,
    statusAt: order.statusAt,
    events: order.events,
    estimatedDate: order.estimatedDate,
  };
}

export function agentTracking(data: unknown): AgentTracking | null {
  const order = readPayload(data);
  if (!order) return null;

  const extra = agentFieldsSchema.safeParse(data);
  const fields = extra.success ? extra.data : {};

  const customer = fields.customer ?? null;
  const address = customer?.address ?? null;
  const zone = address?.zone ?? null;
  const city = zone?.city ?? null;

  return {
    trackingNumber: order.trackingNumber,
    status: order.status,
    statusAt: order.statusAt,
    events: order.events,
    estimatedDate: order.estimatedDate,

    platformId: fields.id != null ? String(fields.id) : null,
    merchantName: order.merchantName,
    merchantPhone: fields.merchant?.store_phone ?? null,
    // `full_name` where the platform composed one, the two halves otherwise —
    // and never a bare first name, which reads as a different person.
    recipientName: customer?.full_name ?? joinName(customer?.first_name, customer?.last_name),
    recipientPhone: customer?.phone ?? customer?.secondary_phone ?? null,
    recipientEmail: customer?.email ?? null,
    addressLines: [address?.line_1, address?.line_2, address?.line_3].filter(isFilled),
    zone: zone?.name ?? null,
    city: city?.name ?? null,
    governorate: city?.governorate?.name ?? null,
    codAmount: readAmount(fields.cash_amount),
    preferredDate: fields.preferred_date ?? null,
    deliveredAt: readInstant(fields.delivered_date),
    pickedUpAt: readInstant(fields.pickup_date),
  };
}

function isFilled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function joinName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const parts = [first, last].filter(isFilled);
  return parts.length ? parts.join(' ') : null;
}

/**
 * The COD amount as a number, however it was serialised.
 *
 * A string is accepted because a money value crossing JSON as `"1245.00"` is
 * ordinary — it is what a decimal column serialises to in a good many stacks,
 * and this one already sends `id` as a number while `tracking_number` is a
 * string. Anything that is not a finite number reads as "no amount" rather than
 * as zero: a parcel with nothing to collect and a parcel we cannot read the
 * amount of must not look the same to an agent about to tell a customer what to
 * have ready.
 */
function readAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A timestamped instant, or null. These carry an offset, so parsing is safe. */
function readInstant(value: string | null | undefined): Date | null {
  if (!isFilled(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}
