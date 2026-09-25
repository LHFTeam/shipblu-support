import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';

const ORIGINAL = process.env;

beforeEach(() => {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    EMAIL_PROVIDER: 'postmark',
    EMAIL_API_KEY: 'server-token',
  } as NodeJS.ProcessEnv;
  resetEnvCache();
  // `emailProvider()` caches its answer for the life of the module.
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL;
  resetEnvCache();
});

async function providerFor(nodeEnv: 'production' | 'development') {
  (process.env as Record<string, string>).NODE_ENV = nodeEnv;
  const { emailProvider } = await import('./index');
  return emailProvider();
}

/**
 * The decision the provider cannot make for itself: whether this deployment may
 * run without the inbound secret. `NODE_ENV` is `production` on the web service
 * that receives the webhook (`render.yaml`) and never under `next dev`, which is
 * exactly the line between "a missing secret is a misconfiguration" and "a
 * missing secret is a laptop".
 */
describe('emailProvider', () => {
  it('refuses unauthenticated inbound mail in production when the secret is unset', async () => {
    const provider = await providerFor('production');

    expect(provider.verifySignature('{}', {})).toBe(false);
  });

  it('keeps accepting it in development, where nothing is configured', async () => {
    const provider = await providerFor('development');

    expect(provider.verifySignature('{}', {})).toBe(true);
  });
});
