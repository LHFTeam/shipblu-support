import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliveryEnvelope,
  noteVerifyingSecret,
  resetVerifyingSecretNotice,
  signingCandidates,
  unverifiedReason,
} from './signing';

const BOTH = { appSecret: 'app-secret', instagramAppSecret: 'ig-secret' };

describe('signingCandidates', () => {
  it('tries the Instagram app secret first for an Instagram delivery', () => {
    // First, not only: an account can be moved back onto its Facebook Page, and
    // the app secret is the right one again the moment it is.
    expect(signingCandidates('instagram', BOTH).map((c) => c.name)).toEqual([
      'META_INSTAGRAM_APP_SECRET',
      'META_APP_SECRET',
    ]);
  });

  it('never offers the Instagram secret to a Page or WhatsApp delivery', () => {
    // Nothing but the `instagram` object can be signed with it, and this is the
    // busiest path in the system — 152,000 WhatsApp deliveries and counting.
    expect(signingCandidates('page', BOTH).map((c) => c.name)).toEqual(['META_APP_SECRET']);
    expect(signingCandidates('whatsapp_business_account', BOTH).map((c) => c.name)).toEqual([
      'META_APP_SECRET',
    ]);
    expect(signingCandidates(undefined, BOTH).map((c) => c.name)).toEqual(['META_APP_SECRET']);
  });

  it('behaves exactly as before when no Instagram secret is set', () => {
    const secrets = { appSecret: 'app-secret', instagramAppSecret: undefined };
    expect(signingCandidates('instagram', secrets).map((c) => c.name)).toEqual(['META_APP_SECRET']);
  });

  it('works when only the Instagram secret is set', () => {
    // A deployment that serves Instagram and nothing else. Refusing to try the
    // one secret it holds because the other is missing would be absurd.
    const secrets = { appSecret: undefined, instagramAppSecret: 'ig-secret' };
    expect(signingCandidates('instagram', secrets).map((c) => c.name)).toEqual([
      'META_INSTAGRAM_APP_SECRET',
    ]);
    expect(signingCandidates('page', secrets)).toEqual([]);
  });

  it('does not hash the same value twice', () => {
    const secrets = { appSecret: 'same', instagramAppSecret: 'same' };
    expect(signingCandidates('instagram', secrets)).toHaveLength(1);
  });
});

describe('unverifiedReason', () => {
  it('names the variables that were tried, never their values', () => {
    const reason = unverifiedReason(signingCandidates('instagram', BOTH));

    expect(reason).toBe('signature did not match META_INSTAGRAM_APP_SECRET or META_APP_SECRET');
    expect(reason).not.toContain('ig-secret');
    expect(reason).not.toContain('app-secret');
  });

  it('says so when nothing is configured at all', () => {
    // A different problem with the same symptom, and the one a fresh deployment
    // has: no secret to check against rather than the wrong one.
    expect(unverifiedReason([])).toMatch(/no app secret is configured/);
  });
});

describe('deliveryEnvelope', () => {
  it('names the handover channel a delivery came in on', () => {
    expect(deliveryEnvelope({ entry: [{ messaging: [{}] }] })).toBe('messaging');
    expect(deliveryEnvelope({ entry: [{ standby: [{}] }] })).toBe('standby');
    expect(deliveryEnvelope({ entry: [{ changes: [{}] }] })).toBe('changes');
  });

  it('does not mistake an empty array for the channel', () => {
    // Meta sends `messaging: []` on some deliveries, and calling that
    // "messaging" would report the wrong channel for the secret that signed it.
    expect(deliveryEnvelope({ entry: [{ messaging: [], standby: [{}] }] })).toBe('standby');
    expect(deliveryEnvelope({ entry: [{}] })).toBe('empty');
    expect(deliveryEnvelope({})).toBe('empty');
  });
});

describe('noteVerifyingSecret', () => {
  afterEach(() => {
    resetVerifyingSecretNotice();
    vi.restoreAllMocks();
  });

  it('says which secret signed which channel, once per pair', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET', 'messaging');
    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET', 'messaging');
    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET', 'messaging');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('META_INSTAGRAM_APP_SECRET');
    expect(log.mock.calls[0]![0]).toContain('messaging');
  });

  it('stays quiet when two secrets alternate, which is the live case', () => {
    /*
      The bug this replaced. Keyed on the secret alone and re-announcing on
      change, this logged a line per delivery on the real deployment, where the
      `messaging` and `standby` copies of one account's traffic are signed
      differently and interleave within seconds. Four pairs, four lines, however
      many hundred deliveries.
    */
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    for (let i = 0; i < 50; i += 1) {
      noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET', 'messaging');
      noteVerifyingSecret('instagram', 'META_APP_SECRET', 'standby');
    }

    expect(log).toHaveBeenCalledTimes(2);
  });

  it('reports the same secret again on a channel it has not been seen on', () => {
    // Which credential signs which channel is the whole answer, so the pair is
    // the unit — not the secret, and not the channel.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('instagram', 'META_APP_SECRET', 'standby');
    noteVerifyingSecret('instagram', 'META_APP_SECRET', 'messaging');

    expect(log).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for WhatsApp and Page deliveries', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('whatsapp_business_account', 'META_APP_SECRET', 'messages');
    noteVerifyingSecret('page', 'META_APP_SECRET', 'standby');
    noteVerifyingSecret(undefined, 'META_APP_SECRET', 'messaging');

    expect(log).not.toHaveBeenCalled();
  });
});
