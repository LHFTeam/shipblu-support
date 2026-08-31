import { describe, expect, it } from 'vitest';
import { agentTracking, publicTracking, storedReturn } from './detail';

/**
 * The same payload shape the platform really returns, with invented personal
 * details — see the note in `platform.test.ts`. The values below are chosen to
 * be unmistakable in a haystack, because the first test here works by looking
 * for them in one.
 */
function stored(): Record<string, unknown> {
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
      first_name: 'Testfirst',
      last_name: 'Testlast',
      full_name: 'Testfirst Testlast',
      email: 'secret.recipient@example.com',
      phone: '01111111111',
      secondary_phone: null,
      address: {
        line_1: '1 Secret Street, Mohandessin',
        line_2: '7-2',
        line_3: null,
        latitude: 30.056261062622,
        longitude: 31.185321807861,
        zone: {
          name: 'Ard El Lewa',
          city: { name: 'Giza', governorate: { name: 'Giza', code: 'EGGZ' } },
        },
      },
    },
    cash_amount: 1245.0,
    preferred_date: '2026-08-27',
    estimated_date: '2026-08-29',
    pickup_date: '2026-08-26T14:36:13.392340+03:00',
    delivered_date: '2026-08-30T11:29:56.745153Z',
    tracking_events: [
      { status: 'delivered', created: '2026-08-30T14:29:56.745153+03:00', comment: null },
      { status: 'created', created: '2026-08-25T18:27:12.318683+03:00', comment: null },
      { status: 'in_transit', created: '2026-08-26T16:44:56.587255+03:00', comment: null },
    ],
  };
}

describe('publicTracking', () => {
  /**
   * The test this file exists for.
   *
   * Written as a search over the serialised result rather than as a list of
   * `toBeUndefined()` assertions, because the failure it is guarding against is
   * a field nobody thought to assert about — a `...order` spread, a passthrough
   * schema, a new personal field the platform adds next year. A whitelist that
   * is checked by naming its exclusions is not a whitelist.
   */
  it('carries nothing personal, anywhere in the shape', () => {
    const view = publicTracking(stored());
    const serialised = JSON.stringify(view);

    for (const secret of [
      'Testfirst',
      'Testlast',
      'secret.recipient@example.com',
      '01111111111',
      '1 Secret Street',
      '01000000000',
      '30.056',
      '31.185',
      '1245',
      'Ard El Lewa',
      'Giza',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('shows the status, its time and the history', () => {
    const view = publicTracking(stored());

    expect(view?.status).toBe('delivered');
    expect(view?.statusAt?.toISOString()).toBe('2026-08-30T11:29:56.745Z');
    // Sorted, as `mapDeliveryOrder` guarantees — the payload above is not.
    expect(view?.events.map((event) => event.status)).toEqual([
      'created',
      'in_transit',
      'delivered',
    ]);
  });

  it('keeps the estimated date a string', () => {
    expect(publicTracking(stored())?.estimatedDate).toBe('2026-08-29');
  });

  it('reads an empty stub as nothing to show, not as an error', () => {
    // `shipments.data` defaults to `{}` for every stub, so this is the ordinary
    // case and must never throw.
    expect(publicTracking({})).toBeNull();
    expect(publicTracking(null)).toBeNull();
    expect(publicTracking(undefined)).toBeNull();
  });

  it('degrades to nothing rather than taking the page down', () => {
    expect(publicTracking({ some: 'junk' })).toBeNull();
    expect(publicTracking('not an object')).toBeNull();
  });
});

describe('agentTracking', () => {
  it('reads the details an agent needs to help a caller', () => {
    const view = agentTracking(stored());

    expect(view?.recipientName).toBe('Testfirst Testlast');
    expect(view?.recipientPhone).toBe('01111111111');
    expect(view?.recipientEmail).toBe('secret.recipient@example.com');
    expect(view?.addressLines).toEqual(['1 Secret Street, Mohandessin', '7-2']);
    expect(view?.zone).toBe('Ard El Lewa');
    expect(view?.city).toBe('Giza');
    expect(view?.governorate).toBe('Giza');
    expect(view?.codAmount).toBe(1245);
    expect(view?.merchantName).toBe('Example Merchant');
    expect(view?.merchantPhone).toBe('01000000000');
    expect(view?.platformId).toBe('3150567');
  });

  it('reads the instants that carry an offset and leaves the calendar dates alone', () => {
    const view = agentTracking(stored());

    expect(view?.deliveredAt?.toISOString()).toBe('2026-08-30T11:29:56.745Z');
    expect(view?.pickedUpAt?.toISOString()).toBe('2026-08-26T11:36:13.392Z');
    expect(view?.preferredDate).toBe('2026-08-27');
    expect(view?.estimatedDate).toBe('2026-08-29');
  });

  it('composes a name when the platform sent only the halves', () => {
    const payload = stored();
    delete (payload.customer as Record<string, unknown>).full_name;
    expect(agentTracking(payload)?.recipientName).toBe('Testfirst Testlast');
  });

  it('never shows a bare first name as if it were the whole one', () => {
    const payload = stored();
    payload.customer = { first_name: 'Testfirst' };
    expect(agentTracking(payload)?.recipientName).toBe('Testfirst');

    payload.customer = {};
    expect(agentTracking(payload)?.recipientName).toBeNull();
  });

  it('reads a COD amount however it was serialised', () => {
    const payload = stored();
    payload.cash_amount = '1245.00';
    expect(agentTracking(payload)?.codAmount).toBe(1245);
  });

  it('separates nothing to collect from an amount it could not read', () => {
    const payload = stored();

    payload.cash_amount = 0;
    expect(agentTracking(payload)?.codAmount).toBe(0);

    payload.cash_amount = 'not a number';
    // Not zero. An agent telling a customer to have nothing ready, when the
    // truth is we could not read the figure, is the error worth separating.
    expect(agentTracking(payload)?.codAmount).toBeNull();
  });

  it('survives a payload with no customer or address at all', () => {
    const payload = stored();
    delete payload.customer;

    const view = agentTracking(payload);
    expect(view?.status).toBe('delivered');
    expect(view?.recipientName).toBeNull();
    expect(view?.addressLines).toEqual([]);
    expect(view?.city).toBeNull();
  });
});

describe('the current estimate', () => {
  it("prefers today's estimate over the one the parcel was booked with", () => {
    // The two really do differ: the live parcel this was built against was
    // booked for the 29th and currently reads the 31st.
    const view = publicTracking(stored(), '2026-08-31');
    expect(view?.estimatedDate).toBe('2026-08-31');
  });

  it('falls back to the booked estimate when there is no current one', () => {
    expect(publicTracking(stored(), null)?.estimatedDate).toBe('2026-08-29');
    expect(publicTracking(stored())?.estimatedDate).toBe('2026-08-29');
  });

  it('keeps both for the console, so an agent can say why it moved', () => {
    const view = agentTracking(stored(), '2026-08-31');
    expect(view?.estimatedDate).toBe('2026-08-31');
    expect(view?.bookedEstimatedDate).toBe('2026-08-29');
  });

  it('still lets nothing personal through when an estimate is supplied', () => {
    // The projection grew a parameter; the guarantee it exists for has not.
    const serialised = JSON.stringify(publicTracking(stored(), '2026-08-31'));
    for (const secret of ['Testfirst', 'secret.recipient@example.com', '01111111111', '1245']) {
      expect(serialised).not.toContain(secret);
    }
  });
});

describe('storedReturn', () => {
  it('is null for a parcel that is not going back', () => {
    expect(storedReturn(stored())).toBeNull();
  });

  it('reads the flag, not the status, straight off a stored payload', () => {
    // The shape production actually holds for a returning parcel: the status
    // still reads `delivery_attempted` and only the flag and an event say
    // otherwise. This is what the ticket sidebar keys on.
    const payload = stored();
    payload.status = 'delivery_attempted';
    payload.rto_requested = true;
    (payload.tracking_events as unknown[]).push({
      status: 'return_to_origin',
      created: '2026-08-30T16:51:45+03:00',
      comment: null,
    });

    const progress = storedReturn(payload);
    expect(progress?.step).toBe(0);
    expect(progress?.startedAt?.toISOString()).toBe('2026-08-30T13:51:45.000Z');
  });

  it('follows the return once it is moving', () => {
    const payload = stored();
    payload.rto_requested = true;
    (payload.tracking_events as unknown[]).push(
      { status: 'return_to_origin', created: '2026-08-30T16:51:45+03:00', comment: null },
      { status: 'out_for_return', created: '2026-09-01T09:00:00+03:00', comment: null },
    );

    expect(storedReturn(payload)?.step).toBe(2);
  });

  it('reads an empty stub as nothing, not as an error', () => {
    expect(storedReturn({})).toBeNull();
    expect(storedReturn(null)).toBeNull();
    expect(storedReturn({ junk: true })).toBeNull();
  });
});
