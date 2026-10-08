import { describe, expect, it } from 'vitest';
import { canRequestSync, parseCoexistence, SYNC_WINDOW_MS } from './coexistence';

/**
 * The copy window is the one decision here that costs a business something
 * when it is wrong: Meta allows each copy once, inside 24 hours, and a request
 * outside either rule is refused — or, worse, a button that would succeed is
 * hidden and the six months of chats are never copied.
 */

const ONBOARDED = '2026-10-08T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(ONBOARDED) + ms);

const connected = (syncs = {}) =>
  parseCoexistence({
    phoneNumberId: '1098765432',
    coexistence: {
      onboardedAt: ONBOARDED,
      wabaId: '102030405',
      displayPhoneNumber: '+20 10 1234 5678',
      verifiedName: 'ShipBlu',
      subscribedAt: ONBOARDED,
      syncs,
    },
  })!;

describe('parseCoexistence', () => {
  it('reads a connected channel, and nothing from a channel that was not connected this way', () => {
    expect(connected()).toMatchObject({ wabaId: '102030405', verifiedName: 'ShipBlu', syncs: {} });
    expect(parseCoexistence({ phoneNumberId: '1098765432' })).toBeNull();
    expect(parseCoexistence(null)).toBeNull();
  });

  /** jsonb written by hand, a migration or an older version must not throw on a page. */
  it('reads a field of the wrong type as absent rather than throwing', () => {
    const parsed = parseCoexistence({
      coexistence: {
        onboardedAt: ONBOARDED,
        wabaId: '102030405',
        displayPhoneNumber: 42,
        syncs: 'nonsense',
        disconnected: { at: 7 },
      },
    });
    expect(parsed).toMatchObject({ displayPhoneNumber: null, syncs: {} });
    expect(parsed?.disconnected).toEqual({ at: '', event: '', reason: null });
    expect(parseCoexistence({ coexistence: { wabaId: '1' } })).toBeNull();
  });
});

describe('canRequestSync', () => {
  it('allows each copy inside the window, until it has been requested', () => {
    expect(canRequestSync(connected(), 'history', at(60_000))).toEqual({ ok: true });
    expect(
      canRequestSync(
        connected({ history: { requestId: 'r-1', requestedAt: ONBOARDED } }),
        'history',
        at(60_000),
      ),
    ).toMatchObject({ ok: false, reason: 'already_requested' });
    // The other copy is its own allowance.
    expect(
      canRequestSync(
        connected({ history: { requestId: 'r-1', requestedAt: ONBOARDED } }),
        'contacts',
        at(60_000),
      ),
    ).toEqual({ ok: true });
  });

  /** A request Meta refused left no request id, so it may be tried again in the window. */
  it('allows a refused request to be tried again', () => {
    expect(
      canRequestSync(
        connected({ contacts: { error: 'Service unavailable', attemptedAt: ONBOARDED } }),
        'contacts',
        at(60_000),
      ),
    ).toEqual({ ok: true });
  });

  it('closes 24 hours after the number was connected', () => {
    expect(canRequestSync(connected(), 'contacts', at(SYNC_WINDOW_MS))).toEqual({ ok: true });
    expect(canRequestSync(connected(), 'contacts', at(SYNC_WINDOW_MS + 1))).toMatchObject({
      ok: false,
      reason: 'window_closed',
      sentence: expect.stringMatching(/24 hours/),
    });
  });
});
