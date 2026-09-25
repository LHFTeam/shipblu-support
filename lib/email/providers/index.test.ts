import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env;

beforeEach(() => {
  // Isolation is `vi.resetModules()` alone: `emailProvider()` caches its answer
  // for the life of the module, and so does `env()`, and a fresh import of the
  // factory brings a fresh copy of both. A `resetEnvCache` imported at the top
  // of this file would reset a different instance from the one the factory
  // reads, and only look like it was doing the work.
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = ORIGINAL;
});

async function providerFor(nodeEnv: 'production' | 'development', driver: Record<string, string>) {
  process.env = {
    NODE_ENV: nodeEnv,
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    ...driver,
  } as NodeJS.ProcessEnv;
  const { emailProvider } = await import('./index');
  return emailProvider();
}

const POSTMARK = { EMAIL_PROVIDER: 'postmark', EMAIL_API_KEY: 'server-token' };
const LOCAL = { EMAIL_PROVIDER: 'local' };

/**
 * Whether a deployment may take an inbound post it cannot authenticate. The
 * answer is no everywhere somebody other than the developer can reach the
 * endpoint: always for Postmark, whose mail only arrives at a public URL, and
 * under NODE_ENV=production for `local` — which staging runs, on a public URL,
 * and which is the schema default a deploy falls back to if EMAIL_PROVIDER is
 * lost.
 */
describe('emailProvider', () => {
  it('refuses unauthenticated Postmark mail in production when the secret is unset', async () => {
    const provider = await providerFor('production', POSTMARK);
    expect(provider.verifySignature('{}', {}).verified).toBe(false);
  });

  it('refuses it in development too, since Postmark only reaches a public URL', async () => {
    const provider = await providerFor('development', POSTMARK);
    expect(provider.verifySignature('{}', {}).verified).toBe(false);
  });

  it('refuses an inbound post to the local driver in production', async () => {
    const provider = await providerFor('production', LOCAL);
    expect(provider.verifySignature('{}', {})).toEqual({
      verified: false,
      reason: expect.stringMatching(/only outside NODE_ENV=production/),
    });
  });

  it('keeps the local driver open in development, where nothing is configured', async () => {
    const provider = await providerFor('development', LOCAL);
    expect(provider.verifySignature('{}', {})).toEqual({ verified: true });
  });
});
