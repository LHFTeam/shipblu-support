import { describe, expect, it } from 'vitest';
import {
  canRequestSync,
  coexistenceBadges,
  historyDone,
  isSyncing,
  needsReconnect,
  parseCoexistence,
  SYNC_STALE_MS,
  SYNC_WINDOW_MS,
  uncopiedAfterWindow,
} from './coexistence';

/**
 * The copy window is the one decision here that costs a business something
 * when it is wrong: Meta allows each copy once, inside 24 hours, and a request
 * outside either rule is refused — or, worse, a button that would succeed is
 * hidden and the six months of chats are never copied.
 */

const ONBOARDED = '2026-10-08T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(ONBOARDED) + ms);

const connected = (syncs = {}, extra = {}) =>
  parseCoexistence({
    phoneNumberId: '1098765432',
    coexistence: {
      onboardedAt: ONBOARDED,
      wabaId: '102030405',
      displayPhoneNumber: '+20 10 1234 5678',
      verifiedName: 'ShipBlu',
      subscribedAt: ONBOARDED,
      syncs,
      ...extra,
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

  /** The two facts the row reads to stop offering what cannot or need not happen. */
  it('reads "not on the Business app" only as a literal true, and carried-over copies by name', () => {
    expect(connected({}, { notOnBusinessApp: true }).notOnBusinessApp).toBe(true);
    expect(connected({}, { notOnBusinessApp: 'false' }).notOnBusinessApp).toBeUndefined();
    expect(connected({}, { carriedOver: ['history', 'nonsense', 7] }).carriedOver).toEqual([
      'history',
    ]);
    expect(connected({}, { carriedOver: 'contacts' }).carriedOver).toBeUndefined();
    expect(connected().carriedOver).toBeUndefined();
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

  /** Meta refuses it, and the refusal would land on the row as a red "failed" badge. */
  it('never allows a copy from a number Meta says is not on the Business app', () => {
    const notOnApp = connected({}, { notOnBusinessApp: true });
    for (const type of ['contacts', 'history'] as const) {
      expect(canRequestSync(notOnApp, type, at(60_000))).toMatchObject({
        ok: false,
        reason: 'not_on_business_app',
        sentence: expect.stringMatching(/no phone to copy from/),
      });
    }
  });

  /** Copying again inside the new window is a choice the row offers on purpose. */
  it('allows a copy an earlier connection made, inside the new window', () => {
    expect(
      canRequestSync(connected({}, { carriedOver: ['history'] }), 'history', at(60_000)),
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

describe('historyDone and isSyncing', () => {
  const requested = (extra = {}) => ({
    history: { requestId: 'r-1', requestedAt: ONBOARDED, ...extra },
  });

  it('is done when every phase reached 100, whatever order they finished in', () => {
    expect(historyDone(connected())).toBe(false);
    expect(historyDone(connected(requested()))).toBe(false);
    expect(
      historyDone(connected(requested({ progressByPhase: { '0': 100, '2': 100 }, chunks: 9 }))),
    ).toBe(false);
    expect(
      historyDone(
        connected(requested({ progressByPhase: { '2': 100, '0': 100, '1': 100 }, chunks: 17 })),
      ),
    ).toBe(true);
  });

  it('is done once the business declined on the phone — there is nothing more to wait for', () => {
    expect(historyDone(connected(requested({ declined: { at: ONBOARDED, code: 2593109 } })))).toBe(
      true,
    );
  });

  it('is syncing only while a requested copy is unfinished and still moving', () => {
    expect(isSyncing(connected(), at(60_000))).toBe(false);
    expect(isSyncing(connected(requested()), at(60_000))).toBe(true);
    // A day with nothing arriving: the phone is closed, and the page stops asking.
    expect(isSyncing(connected(requested()), at(SYNC_STALE_MS + 1))).toBe(false);
    // Unless a chunk moved it since.
    const movedAt = new Date(Date.parse(ONBOARDED) + SYNC_STALE_MS).toISOString();
    expect(
      isSyncing(connected(requested({ lastReceivedAt: movedAt })), at(SYNC_STALE_MS + 1)),
    ).toBe(true);
    expect(
      isSyncing(
        connected(requested({ progressByPhase: { '0': 100, '1': 100, '2': 100 } })),
        at(60_000),
      ),
    ).toBe(false);
  });
});

describe('coexistenceBadges', () => {
  const labels = (syncs = {}, now = at(60_000), extra = {}) =>
    coexistenceBadges(
      parseCoexistence({
        coexistence: {
          onboardedAt: ONBOARDED,
          wabaId: '102030405',
          displayPhoneNumber: '+20 10 1234 5678',
          verifiedName: 'ShipBlu',
          subscribedAt: ONBOARDED,
          syncs,
          ...extra,
        },
      })!,
      now,
    ).map((badge) => badge.label);

  it('always names the connection, and every badge explains itself', () => {
    const badges = coexistenceBadges(connected(), at(60_000));
    expect(badges[0]).toMatchObject({ label: 'WhatsApp Business app', tone: 'brand' });
    expect(badges[0]!.explain).toMatch(/phone-typed|typed there/);
    for (const badge of badges) expect(badge.explain.length).toBeGreaterThan(20);
  });

  /**
   * A number Meta says is not on the app has no phone typing replies and
   * nothing to copy: its window closing is nothing missed, and it is not
   * offered a reconnect for it.
   */
  it('says a number not on the Business app is a Cloud API number, with no copy to miss', () => {
    const notOnApp = connected({}, { notOnBusinessApp: true });
    const after = coexistenceBadges(notOnApp, at(SYNC_WINDOW_MS + 1));

    expect(after[0]).toMatchObject({ label: 'connected through Meta', tone: 'brand' });
    expect(after[0]!.explain).toMatch(/not on the WhatsApp Business app/);
    expect(after[0]!.explain).not.toMatch(/typed there/);
    expect(after.map((badge) => badge.label)).not.toContain('copy window closed');
    expect(uncopiedAfterWindow(notOnApp, at(SYNC_WINDOW_MS + 1))).toEqual([]);
    expect(needsReconnect(notOnApp, at(SYNC_WINDOW_MS + 1))).toBe(false);
  });

  /**
   * A reconnect asks for nothing an earlier connection copied, so its own
   * slots are empty. Read alone, they called six months of imported chats
   * "never copied" and offered a reconnect to fetch them again.
   */
  it('counts what an earlier connection copied as copied', () => {
    const both = connected({}, { carriedOver: ['contacts', 'history'] });
    const afterWindow = at(SYNC_WINDOW_MS + 1);

    const labelsAfter = coexistenceBadges(both, afterWindow).map((badge) => badge.label);
    expect(labelsAfter).not.toContain('copy window closed');
    expect(labelsAfter).toContain('contacts and history copied before');
    expect(needsReconnect(both, afterWindow)).toBe(false);

    // Only the contacts carried over: the history is what the window missed.
    const contactsOnly = connected({}, { carriedOver: ['contacts'] });
    expect(uncopiedAfterWindow(contactsOnly, afterWindow)).toEqual(['history']);
    const closed = coexistenceBadges(contactsOnly, afterWindow).find(
      (badge) => badge.label === 'copy window closed',
    );
    expect(closed?.explain).toMatch(/the chat history was never copied/);
    expect(closed?.explain).not.toMatch(/contacts/);
    expect(needsReconnect(contactsOnly, afterWindow)).toBe(true);

    // Copied again in this window: that copy's own badge says so instead.
    expect(
      coexistenceBadges(
        connected(
          { contacts: { requestId: 'c', requestedAt: ONBOARDED, received: 3 } },
          { carriedOver: ['contacts'] },
        ),
        at(60_000),
      ).map((badge) => badge.label),
    ).not.toContain('contacts copied before');
  });

  it('follows the history through its states', () => {
    expect(labels({ history: { requestId: 'r', requestedAt: ONBOARDED } })).toContain(
      'copying history · waiting for the phone',
    );
    expect(
      labels({
        history: {
          requestId: 'r',
          requestedAt: ONBOARDED,
          chunks: 17,
          progressByPhase: { '0': 100, '1': 100, '2': 40 },
        },
      }),
    ).toContain('copying history 2/3 · 40%');
    expect(
      labels({
        history: {
          requestId: 'r',
          requestedAt: ONBOARDED,
          chunks: 30,
          progressByPhase: { '0': 100, '1': 100, '2': 100 },
        },
      }),
    ).toContain('history copied');
    expect(
      labels({
        history: {
          requestId: 'r',
          requestedAt: ONBOARDED,
          declined: { at: ONBOARDED, code: 2593109 },
        },
      }),
    ).toContain('history declined on the phone');
    expect(labels({ history: { error: 'Service unavailable', attemptedAt: ONBOARDED } })).toContain(
      'history failed',
    );
    // A copy nothing has moved for a day is a closed phone, not a copy in progress.
    expect(
      labels(
        { history: { requestId: 'r', requestedAt: ONBOARDED, progressByPhase: { '0': 40 } } },
        at(SYNC_STALE_MS + 1),
      ),
    ).toContain('history stalled at 0%');
  });

  /**
   * The declined request holds Meta's request id and Meta asks the phone once
   * per connection, so no copy button can ask again — the badge used to send
   * the admin to one that is never drawn.
   */
  it('sends a declined history to Reconnect, not to a copy button the row never shows', () => {
    const declined = connected({
      contacts: { requestId: 'c', requestedAt: ONBOARDED, received: 3 },
      history: {
        requestId: 'r',
        requestedAt: ONBOARDED,
        declined: { at: ONBOARDED, code: 2593109 },
      },
    });
    const badge = coexistenceBadges(declined, at(60_000)).find(
      (candidate) => candidate.label === 'history declined on the phone',
    );

    expect(badge?.explain).toMatch(/press Reconnect/);
    expect(badge?.explain).not.toMatch(/Copy history again/);
    expect(canRequestSync(declined, 'history', at(60_000)).ok).toBe(false);
    // Inside the window and long after it: the decline is final for this connection.
    expect(needsReconnect(declined, at(60 * 60 * 1000))).toBe(true);
    expect(needsReconnect(declined, at(30 * SYNC_WINDOW_MS))).toBe(true);

    const copied = connected({
      contacts: { requestId: 'c', requestedAt: ONBOARDED, received: 3 },
      history: { requestId: 'r', requestedAt: ONBOARDED },
    });
    expect(needsReconnect(copied, at(60 * 60 * 1000))).toBe(false);
    expect(needsReconnect(copied, at(30 * SYNC_WINDOW_MS))).toBe(false);
  });

  /**
   * `ACCOUNT_OFFBOARDED` is a phone change Meta undoes by itself; reconnecting
   * through the window for it unlinks the phone's devices for nothing. Every
   * other event — and one this module has not met — keeps the safe instruction.
   */
  it('tells an offboarded number to wait for Meta, and anything else to reconnect', () => {
    const disconnectedBy = (event: string) =>
      coexistenceBadges(
        connected({}, { disconnected: { at: ONBOARDED, event, reason: null } }),
        at(60_000),
      ).find((badge) => badge.label === 'disconnected on the phone')!;

    const offboarded = disconnectedBy('ACCOUNT_OFFBOARDED');
    expect(offboarded.tone).toBe('warning');
    expect(offboarded.explain).toMatch(/Meta reconnects it on its own/);
    expect(offboarded.explain).toMatch(/Press Reconnect only if the badge is still here/);
    expect(offboarded.explain).not.toMatch(/press Reconnect and complete/);

    for (const event of ['PARTNER_REMOVED', '', 'SOMETHING_NEW']) {
      const badge = disconnectedBy(event);
      expect(badge.tone).toBe('danger');
      expect(badge.explain).toMatch(/press Reconnect and complete the window again/);
    }

    // The button stays either way: if Meta's reconnection never arrives, it is the way back.
    expect(
      needsReconnect(
        connected(
          {},
          { disconnected: { at: ONBOARDED, event: 'ACCOUNT_OFFBOARDED', reason: null } },
        ),
        at(60_000),
      ),
    ).toBe(true);
  });

  it('counts the contacts, and names a disconnection and a window that closed unused', () => {
    expect(
      labels({ contacts: { requestId: 'c', requestedAt: ONBOARDED, received: 412 } }),
    ).toContain('412 contacts');
    expect(labels({ contacts: { requestId: 'c', requestedAt: ONBOARDED } })).toContain(
      'waiting for contacts',
    );
    expect(
      labels({}, at(60_000), {
        disconnected: { at: ONBOARDED, event: 'PARTNER_REMOVED', reason: 'user removed' },
      }),
    ).toContain('disconnected on the phone');

    // Inside the window nothing is said about a copy not yet asked for; after it, it is.
    expect(labels({})).not.toContain('copy window closed');
    expect(labels({}, at(SYNC_WINDOW_MS + 1))).toContain('copy window closed');
    // Requested in time: the window closing is nothing to report.
    expect(
      labels(
        {
          contacts: { requestId: 'c', requestedAt: ONBOARDED, received: 1 },
          history: { requestId: 'r', requestedAt: ONBOARDED, progressByPhase: { '0': 100 } },
        },
        at(SYNC_WINDOW_MS + 1),
      ),
    ).not.toContain('copy window closed');
  });
});
