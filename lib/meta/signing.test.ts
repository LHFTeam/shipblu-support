import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

describe('noteVerifyingSecret', () => {
  afterEach(() => {
    resetVerifyingSecretNotice();
    vi.restoreAllMocks();
  });

  it('says which secret verified, once', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET');
    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET');
    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET');

    // Once, not three times: this endpoint takes 152,000 deliveries a week, and
    // a line per delivery is noise that trains people to ignore the log.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('META_INSTAGRAM_APP_SECRET');
  });

  it('says it again when the answer changes', () => {
    // The transition that matters: an account moved between the two setups is
    // otherwise invisible, because both produce a verified delivery.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('instagram', 'META_INSTAGRAM_APP_SECRET');
    noteVerifyingSecret('instagram', 'META_APP_SECRET');

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]![0]).toContain('META_APP_SECRET');
  });

  it('stays quiet for WhatsApp and Page deliveries', () => {
    // Only Instagram has two possible signers, so only Instagram has anything
    // to report — and those two objects are the busy ones.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    noteVerifyingSecret('whatsapp_business_account', 'META_APP_SECRET');
    noteVerifyingSecret('page', 'META_APP_SECRET');
    noteVerifyingSecret(undefined, 'META_APP_SECRET');

    expect(log).not.toHaveBeenCalled();
  });
});
