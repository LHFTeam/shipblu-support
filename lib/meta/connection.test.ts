import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { instagramLoginConfigured, metaConnection } from './connection';

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
