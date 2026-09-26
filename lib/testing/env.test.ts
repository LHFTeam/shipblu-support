import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { setTestEnv, withTestEnv } from './env';

// Set on the real environment before any hook runs: a variable the shell
// running the suite exported.
process.env.EXPORTED_BY_THE_SHELL = 'leaked';

describe('withTestEnv', () => {
  withTestEnv({ FACEBOOK_PAGE_ID: '456' });

  it('starts from the required variables and the named ones, and nothing else', () => {
    expect(process.env.EXPORTED_BY_THE_SHELL).toBeUndefined();
    expect(env().FACEBOOK_PAGE_ID).toBe('456');
    expect(env().DATABASE_URL).toBeTruthy();
  });

  it('lets a test change its environment, and env() sees the change', () => {
    setTestEnv({ FACEBOOK_PAGE_ID: '789', INSTAGRAM_ACCOUNT_ID: '17841400000000000' });
    expect(env().FACEBOOK_PAGE_ID).toBe('789');

    setTestEnv({ INSTAGRAM_ACCOUNT_ID: undefined });
    expect('INSTAGRAM_ACCOUNT_ID' in process.env).toBe(false);
    expect(env().INSTAGRAM_ACCOUNT_ID).toBeUndefined();
  });

  // Runs after the test above, which is the point: nothing it changed is here.
  it('puts back what the previous test changed', () => {
    expect(env().FACEBOOK_PAGE_ID).toBe('456');
  });
});

describe('after the scope ends', () => {
  it('is the real environment again', () => {
    expect(process.env.EXPORTED_BY_THE_SHELL).toBe('leaked');
  });
});
