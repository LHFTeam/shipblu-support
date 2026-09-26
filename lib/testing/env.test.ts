import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { setTestEnv, withTestEnv } from './env';

// Set on the real environment before any hook runs: a variable the shell
// running the suite exported.
process.env.EXPORTED_BY_THE_SHELL = 'leaked';

// Two of these tests check what an earlier one left behind, so the order is
// pinned against `--sequence.shuffle`. Under `-t` the earlier test may not have
// run at all; each check then skips rather than passing without checking.
describe('the env fixture', { shuffle: false }, () => {
  let changedByAnEarlierTest = false;

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
      changedByAnEarlierTest = true;
    });

    it('puts back what the previous test changed', (ctx) => {
      if (!changedByAnEarlierTest) ctx.skip();
      expect(env().FACEBOOK_PAGE_ID).toBe('456');
    });
  });

  describe('after the scope ends', () => {
    it('is the real environment again', (ctx) => {
      if (!changedByAnEarlierTest) ctx.skip();
      expect(process.env.EXPORTED_BY_THE_SHELL).toBe('leaked');
    });

    it('refuses setTestEnv, which nothing would restore', () => {
      expect(() => setTestEnv({ FACEBOOK_PAGE_ID: '1' })).toThrow(/outside withTestEnv/);
      expect(process.env.FACEBOOK_PAGE_ID).toBeUndefined();
    });
  });
});
