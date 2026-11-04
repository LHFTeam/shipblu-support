import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { instagramLoginConfigured, metaConnection, unifiedLoginConfigured } from './connection';

withTestEnv();

describe('metaConnection', () => {
  it('sends Instagram over the direct connection once it has a credential', () => {
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token' });

    expect(metaConnection('instagram')).toBe('instagram_login');
    expect(instagramLoginConfigured()).toBe(true);
  });

  it('falls back to the Facebook Page when it has none', () => {
    // Unset must mean exactly the behaviour every deployment had before the
    // second connection existed — staging holds no Meta credentials at all.
    expect(metaConnection('instagram')).toBe('facebook_page');
    expect(instagramLoginConfigured()).toBe(false);
  });

  it('never routes Facebook anywhere but the Page', () => {
    // A Page has no second way to be reached, and the Instagram token cannot
    // address one. This is the case a "prefer the newest credential" rule would
    // get wrong.
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token' });

    expect(metaConnection('facebook')).toBe('facebook_page');
  });

  it('sends Instagram over Unified Login ahead of both once it has a credential', () => {
    /*
      The order is the point. The direct connection's token expired on
      2026-10-29 and the Page's route is refused by another app's thread
      control, so the never-expiring token with no handover to be second to
      wins — and it wins while the other two are still set, because activating
      it must not wait on anybody unsetting a variable first (§6.29 is what
      unsetting one too early costs).
    */
    setTestEnv({
      INSTAGRAM_UNIFIED_LOGIN_TOKEN: 'unified-token',
      INSTAGRAM_ACCESS_TOKEN: 'ig-token',
    });

    expect(metaConnection('instagram')).toBe('unified_login');
    expect(unifiedLoginConfigured()).toBe(true);
    expect(instagramLoginConfigured()).toBe(true);
    expect(metaConnection('facebook')).toBe('facebook_page');
  });

  it('is unconfigured for Unified Login until its own token is set', () => {
    // The Page token and the Instagram token are not stand-ins: the first
    // cannot address the account's messages past the handover, and the second
    // is refused by graph.facebook.com outright.
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token' });

    expect(unifiedLoginConfigured()).toBe(false);
    expect(metaConnection('instagram')).toBe('instagram_login');
  });

  it('reads the credential live rather than at import', () => {
    /*
      The routing rule is asked on every send, and a rotation or a deploy that
      sets the token must take effect without the process being restarted with a
      module cache primed differently. It is also what makes `endpoint()` and the
      console's own verdict impossible to disagree about — they call this, not a
      value captured once.
    */
    expect(metaConnection('instagram')).toBe('facebook_page');

    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token' });

    expect(metaConnection('instagram')).toBe('instagram_login');
  });
});
