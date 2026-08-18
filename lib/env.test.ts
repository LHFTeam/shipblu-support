import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUrl, env, replyDomain, resetEnvCache } from './env';

/**
 * The case these exist for: a cron job that only wants a database connection
 * should not fail validation over a variable it never uses. That is not
 * hypothetical — every cron in the Blueprint died on a missing APP_URL, hourly,
 * because `db/client.ts` validates the whole schema before connecting.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
  } as NodeJS.ProcessEnv;
  resetEnvCache();
});

afterEach(() => {
  process.env = ORIGINAL;
  resetEnvCache();
});

describe('env', () => {
  it('validates with only what a background job needs', () => {
    expect(() => env()).not.toThrow();
    expect(env().DATABASE_URL).toBe('postgresql://localhost:5432/test');
  });

  it('still refuses to run without a database URL', () => {
    delete process.env.DATABASE_URL;
    resetEnvCache();
    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it('still refuses a too-short APP_SECRET', () => {
    process.env.APP_SECRET = 'short';
    resetEnvCache();
    expect(() => env()).toThrow(/APP_SECRET/);
  });
});

describe('appUrl', () => {
  it('throws where a link is built rather than at startup', () => {
    // The error names what could not be built, instead of surfacing in a job
    // that never wanted a URL.
    expect(() => appUrl()).toThrow(/APP_URL/);
  });

  it('trims a trailing slash so callers can append a path', () => {
    process.env.APP_URL = 'https://support.shipblu.com/';
    resetEnvCache();
    expect(appUrl()).toBe('https://support.shipblu.com');
  });
});

describe('replyDomain', () => {
  it('derives the domain from the sending address', () => {
    process.env.EMAIL_FROM_ADDRESS = 'support@shipblu.com';
    resetEnvCache();
    expect(replyDomain()).toBe('shipblu.com');
  });

  it('prefers an explicit override', () => {
    process.env.EMAIL_FROM_ADDRESS = 'support@mail.shipblu.com';
    process.env.EMAIL_REPLY_DOMAIN = 'shipblu.com';
    resetEnvCache();
    expect(replyDomain()).toBe('shipblu.com');
  });

  it('says so when neither is set', () => {
    expect(() => replyDomain()).toThrow(/EMAIL_REPLY_DOMAIN or EMAIL_FROM_ADDRESS/);
  });
});
