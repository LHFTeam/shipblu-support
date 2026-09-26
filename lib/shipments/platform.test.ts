import { describe, expect, it } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import {
  fetchCurrentEstimatedDate,
  fetchDeliveryOrder,
  mapDeliveryOrder,
  ShipbluApiError,
  type DeliveryOrder,
} from './platform';

/**
 * The delivery-order payload, in the shape the real endpoint returns it.
 *
 * Taken from a live response for a real tracking number and then **stripped of
 * that customer's personal data**: the name, email, phone, street address and
 * coordinates below are invented. Nothing here needs them to be real — every
 * assertion in this file is about statuses, ordering and timestamps — and the
 * endpoint hands all of it to anyone holding a tracking number, which is a
 * reason to keep a real person's details out of a git history, not a reason to
 * think they are public.
 *
 * What *is* faithful, because the tests exist for it:
 *
 * - `tracking_events` in the order the platform sends them, which is **no order
 *   at all** — `created` last, `delivered` third.
 * - `id` as a JSON number while `tracking_number` is a JSON string.
 * - `+03:00` offsets on the events and a `Z` instant on `delivered_date`, which
 *   between them are the same moment and prove the mapping agrees with the
 *   platform's own summary field.
 * - `estimated_date` and `preferred_date` as bare calendar dates.
 * - Fields nothing maps (`cash_amount`, warehouses, `on_hold`), so the raw
 *   passthrough is tested against a payload that actually has some.
 */
/** A body whose read fails the way a deadline passing mid-read does. */
function stalledBody(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      },
    }),
    { status: 200 },
  );
}

function deliveryOrderPayload(): Record<string, unknown> {
  return {
    id: 3150567,
    tracking_number: '1755021358719',
    status: 'delivered',
    merchant: {
      id: 7550,
      name: 'EXAMPLE MERCHANT LTD',
      display_name: 'Example Merchant',
      store_phone: '01000000000',
    },
    customer: {
      id: 3145801,
      first_name: 'Test',
      last_name: 'Recipient',
      email: 'test.recipient@example.com',
      phone: '01000000001',
      full_name: 'Test Recipient',
      secondary_phone: null,
    },
    visit_dates: ['2026-08-29', '2026-08-30', '2026-08-31'],
    created: '2026-08-25T18:27:12.017617+03:00',
    preferred_date: '2026-08-27',
    preferred_window: [],
    estimated_date: '2026-08-29',
    pickup_date: '2026-08-26T14:36:13.392340+03:00',
    cash_amount: 1245.0,
    inbound_warehouse: 20,
    current_warehouse: null,
    outbound_warehouse: 1,
    modified: '2026-08-30T14:29:56.738470+03:00',
    rto_requested: false,
    delivered_date: '2026-08-30T11:29:56.745153Z',
    on_hold: null,
    tracking_events: [
      { status: 'en_route', created: '2026-08-30T02:57:34.326183+03:00', comment: null },
      { status: 'in_transit', created: '2026-08-30T03:00:48.680013+03:00', comment: null },
      { status: 'delivered', created: '2026-08-30T14:29:56.745153+03:00', comment: null },
      { status: 'in_transit', created: '2026-08-26T16:44:56.587255+03:00', comment: null },
      { status: 'out_for_pickup', created: '2026-08-26T13:01:28.397081+03:00', comment: null },
      { status: 'pickup_requested', created: '2026-08-25T23:45:45.093812+03:00', comment: null },
      { status: 'picked_up', created: '2026-08-26T14:36:13.392340+03:00', comment: null },
      { status: 'in_transit', created: '2026-08-30T00:44:36.382673+03:00', comment: null },
      { status: 'out_for_delivery', created: '2026-08-30T10:00:05.804850+03:00', comment: null },
      { status: 'created', created: '2026-08-25T18:27:12.318683+03:00', comment: null },
    ],
  };
}

describe('mapDeliveryOrder', () => {
  it('sorts the events the platform sends unordered', () => {
    const order = mapDeliveryOrder(deliveryOrderPayload());

    // The payload's own first and last entries are `en_route` and `created`.
    // Reading either as "the latest" is the bug this ordering exists to stop.
    expect(order.events.map((event) => event.status)).toEqual([
      'created',
      'pickup_requested',
      'out_for_pickup',
      'picked_up',
      'in_transit',
      'in_transit',
      'en_route',
      'in_transit',
      'out_for_delivery',
      'delivered',
    ]);
  });

  it('dates the status from the event that matches it, not the newest row', () => {
    const order = mapDeliveryOrder(deliveryOrderPayload());

    // The platform's own `delivered_date`, to the millisecond — which is the
    // independent check that the rule picked the right row out of ten.
    expect(order.statusAt?.toISOString()).toBe('2026-08-30T11:29:56.745Z');
  });

  it('takes the most recent matching event when a status repeats', () => {
    const payload = deliveryOrderPayload();
    payload.status = 'in_transit';

    // Three `in_transit` events; the last is 2026-08-30T03:00:48.680+03:00.
    const order = mapDeliveryOrder(payload);
    expect(order.statusAt?.toISOString()).toBe('2026-08-30T00:00:48.680Z');
  });

  it('falls back to the newest event when no event matches the status', () => {
    const payload = deliveryOrderPayload();
    payload.status = 'awaiting_customer_action';

    const order = mapDeliveryOrder(payload);
    expect(order.statusAt?.toISOString()).toBe('2026-08-30T11:29:56.745Z');
  });

  it('leaves the status label exactly as the platform wrote it', () => {
    const payload = deliveryOrderPayload();
    payload.status = 'Out_For_Delivery';

    // Never normalised on write: `status_label` is free text so an ops rename is
    // not an `ALTER TYPE`, and reading it into a stage is `status.ts`'s job.
    expect(mapDeliveryOrder(payload).status).toBe('Out_For_Delivery');
  });

  it('keeps calendar dates as strings', () => {
    const order = mapDeliveryOrder(deliveryOrderPayload());

    // `new Date('2026-08-29')` is midnight UTC, which is 02:00 in Cairo and
    // renders as the day before west of Greenwich. A calendar date is not an
    // instant.
    expect(order.estimatedDate).toBe('2026-08-29');
    expect(order.preferredDate).toBe('2026-08-27');
  });

  it('canonicalises the tracking number and stringifies the platform id', () => {
    const order = mapDeliveryOrder(deliveryOrderPayload());
    expect(order.trackingNumber).toBe('1755021358719');
    expect(order.platformId).toBe('3150567');
  });

  it('reads a tracking number that arrives as a JSON number', () => {
    const payload = deliveryOrderPayload();
    payload.tracking_number = 1755021358719;
    expect(mapDeliveryOrder(payload).trackingNumber).toBe('1755021358719');
  });

  it('prefers the name the merchant chose to be called', () => {
    expect(mapDeliveryOrder(deliveryOrderPayload()).merchantName).toBe('Example Merchant');
  });

  it('carries the whole untouched response through for shipments.data', () => {
    const payload = deliveryOrderPayload();
    const order = mapDeliveryOrder(payload);

    // Everything unmapped still has to reach the database, or the sync quietly
    // discards the half of the payload nobody has needed yet.
    expect(order.raw.cash_amount).toBe(1245.0);
    expect(order.raw.inbound_warehouse).toBe(20);
    expect(order.raw).toEqual(payload);
  });

  it('survives a field the platform adds without telling anyone', () => {
    const payload = deliveryOrderPayload();
    payload.some_new_field = { nested: true };

    const order = mapDeliveryOrder(payload);
    expect(order.status).toBe('delivered');
    expect(order.raw.some_new_field).toEqual({ nested: true });
  });

  it('drops an unreadable event rather than failing the whole sync', () => {
    const payload = deliveryOrderPayload();
    (payload.tracking_events as unknown[]).push({ status: 'weird', created: 'not a date' });

    const order = mapDeliveryOrder(payload);
    expect(order.events).toHaveLength(10);
    expect(order.statusAt?.toISOString()).toBe('2026-08-30T11:29:56.745Z');
  });

  it('reads an order that has no events at all', () => {
    const payload = deliveryOrderPayload();
    payload.tracking_events = [];

    const order = mapDeliveryOrder(payload);
    // A label with no time under it is honest; a label with a guessed time is not.
    expect(order.statusAt).toBeNull();
    expect(order.status).toBe('delivered');
  });

  it('refuses a body that is not a delivery order, permanently', () => {
    // A malformed payload is malformed again on the retry, so a queue that keeps
    // asking only delays somebody noticing.
    expect(() => mapDeliveryOrder({ detail: 'Not found.' })).toThrow(ShipbluApiError);
    try {
      mapDeliveryOrder({ detail: 'Not found.' });
    } catch (error) {
      expect((error as ShipbluApiError).isTransient).toBe(false);
    }
  });
});

describe('fetchDeliveryOrder', () => {
  const BASE = 'https://platform.test';

  it('asks the delivery-order endpoint, and sends no pin', async () => {
    const mock = stubFetch(() => Response.json(deliveryOrderPayload()));

    const order = await fetchDeliveryOrder('1755021358719', { baseUrl: BASE });

    expect(mock).toHaveBeenCalledTimes(1);
    const url = String(mock.mock.calls[0]![0]);
    expect(url).toBe(`${BASE}/api/v1/delivery-order/1755021358719/`);
    // The parameter exists in the documented URL and the endpoint does not check
    // it. Sending one would imply a protection that is not there.
    expect(url).not.toContain('pin');
    expect((order as DeliveryOrder).status).toBe('delivered');
  });

  it('normalises what it is given before asking', async () => {
    const mock = stubFetch(() => Response.json(deliveryOrderPayload()));

    // Arabic-Indic digits and a stray bidi mark, both of which reach us daily.
    await fetchDeliveryOrder('‏١٧٥٥٠٢١٣٥٨٧١٩', { baseUrl: BASE });

    expect(String(mock.mock.calls[0]![0])).toBe(`${BASE}/api/v1/delivery-order/1755021358719/`);
  });

  it('reads a 404 as a definite answer, not an error', async () => {
    stubFetch(() => Response.json({ detail: 'Not found.' }, { status: 404 }));
    await expect(fetchDeliveryOrder('9999999999999', { baseUrl: BASE })).resolves.toBeNull();
  });

  it('treats 5xx and 429 as worth another attempt', async () => {
    for (const status of [500, 502, 503, 429]) {
      stubFetch(() => new Response('', { status }));
      await expect(fetchDeliveryOrder('1755021358719', { baseUrl: BASE })).rejects.toMatchObject({
        isTransient: true,
        status,
      });
    }
  });

  it('treats a 4xx that is not 404 as permanent', async () => {
    stubFetch(() => new Response('', { status: 400 }));
    await expect(fetchDeliveryOrder('1755021358719', { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: false,
      status: 400,
    });
  });

  it('treats an unreachable platform as transient, and never as not-found', async () => {
    stubFetch(async () => {
      throw new Error('socket hang up');
    });

    // The distinction that matters: a timeout must never be allowed to stamp
    // `not_found` on a parcel that exists.
    await expect(fetchDeliveryOrder('1755021358719', { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: true,
      status: null,
    });
  });

  // A deadline reads as one, in seconds: at the status it had read as the
  // signal's own nameless "aborted due to timeout", and mid-body as a 200 that
  // was not JSON — which points whoever is on call at a proxy, not at latency.
  it('names a deadline that passed before the status, in seconds', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(fetchDeliveryOrder('1755021358719', { baseUrl: BASE })).rejects.toThrow(
      /did not answer in \d+s/,
    );
  });

  it('names a deadline that passed mid-body, rather than calling the answer not JSON', async () => {
    stubFetch(() => stalledBody());
    const failure = fetchDeliveryOrder('1755021358719', { baseUrl: BASE });
    await expect(failure).rejects.toThrow(/did not finish arriving in \d+s/);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
  });

  it('treats a 200 that is not JSON as transient', async () => {
    // What a captive portal or a proxy error page looks like from here.
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(fetchDeliveryOrder('1755021358719', { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: true,
    });
  });

  it('refuses an empty tracking number without a round trip', async () => {
    const mock = stubFetch(() => Response.json(deliveryOrderPayload()));
    await expect(fetchDeliveryOrder('   ', { baseUrl: BASE })).rejects.toThrow(ShipbluApiError);
    expect(mock).not.toHaveBeenCalled();
  });
});

/**
 * The second endpoint: `/api/v1/orders/<id>/current-estimated-date/`.
 *
 * Its whole subtlety is in one field. It answers with a full instant —
 * `2026-08-31T23:49:51.999811+03:00` — and **the time is not data**: two live
 * calls three seconds apart came back three seconds apart, tracking the request
 * clock. Only the date means anything, and reading it the obvious way is wrong
 * for three hours of every night.
 */
describe('fetchCurrentEstimatedDate', () => {
  const BASE = 'https://platform.test';

  it('asks the orders endpoint by numeric id', async () => {
    const mock = stubFetch(() =>
      Response.json({
        order_id: 3150567,
        tracking_number: '1755021358719',
        current_estimated_date: '2026-08-31T23:49:51.999811+03:00',
      }),
    );

    const estimate = await fetchCurrentEstimatedDate('3150567', { baseUrl: BASE });

    expect(String(mock.mock.calls[0]![0])).toBe(
      `${BASE}/api/v1/orders/3150567/current-estimated-date/`,
    );
    expect(estimate?.date).toBe('2026-08-31');
    expect(estimate?.trackingNumber).toBe('1755021358719');
  });

  /**
   * The bug this function is written to avoid.
   *
   * `new Date('2026-08-31T00:30:00+03:00').toISOString().slice(0, 10)` is
   * `2026-08-30` — the day before the platform means. Reading the digits the
   * platform wrote is correct at every hour; converting through an instant is
   * correct for twenty-one of them.
   */
  it('reads the date the platform wrote, not the date in UTC', async () => {
    stubFetch(() =>
      Response.json({
        order_id: 1,
        tracking_number: null,
        current_estimated_date: '2026-08-31T00:30:00.000000+03:00',
      }),
    );

    const estimate = await fetchCurrentEstimatedDate('1', { baseUrl: BASE });

    expect(estimate?.date).toBe('2026-08-31');
    // Proof the naive reading really would have differed here.
    expect(new Date('2026-08-31T00:30:00.000000+03:00').toISOString().slice(0, 10)).toBe(
      '2026-08-30',
    );
  });

  it('reads a bare calendar date too', async () => {
    stubFetch(() => Response.json({ order_id: 1, current_estimated_date: '2026-09-01' }));
    expect((await fetchCurrentEstimatedDate('1', { baseUrl: BASE }))?.date).toBe('2026-09-01');
  });

  it('reads no estimate as no estimate', async () => {
    stubFetch(() => Response.json({ order_id: 1, current_estimated_date: null }));
    await expect(fetchCurrentEstimatedDate('1', { baseUrl: BASE })).resolves.toBeNull();
  });

  it('reads a 404 as a definite answer', async () => {
    stubFetch(() => Response.json({ detail: 'Not found.' }, { status: 404 }));
    await expect(fetchCurrentEstimatedDate('999999999', { baseUrl: BASE })).resolves.toBeNull();
  });

  it('refuses anything that is not a numeric id, without a round trip', async () => {
    const mock = stubFetch(() => Response.json({}));

    // The id is interpolated into a path, and a malformed one makes this API
    // serve an HTML error page rather than JSON — verified against the real one.
    for (const bad of ['abc', '', '12a', '../3150567']) {
      await expect(fetchCurrentEstimatedDate(bad, { baseUrl: BASE })).rejects.toMatchObject({
        isTransient: false,
      });
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('treats an unreachable platform as transient', async () => {
    stubFetch(async () => {
      throw new Error('socket hang up');
    });

    await expect(fetchCurrentEstimatedDate('3150567', { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: true,
    });
  });
});
