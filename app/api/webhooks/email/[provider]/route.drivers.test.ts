import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The route with the real driver behind it. `route.test.ts` replaces the
 * provider with a fixed answer, which pins the route's decisions but not the
 * path a production deploy actually takes — environment, factory, driver,
 * route. This file keeps that path whole and replaces only the database, the
 * queue and the logger.
 */

const writes: Record<string, unknown>[] = [];

vi.mock('@/db/client', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.push(values);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: 'event-1' }] }) };
      },
    }),
  },
}));

const enqueue = vi.fn(async () => {});
vi.mock('@/lib/queue', () => ({ enqueue }));
vi.mock('@/lib/webhooks/log', () => ({ logIncomingWebhook: () => {} }));

const ORIGINAL = process.env;
const MESSAGE_ID = '0a1b2c3d-real-delivery';

beforeEach(() => {
  writes.length = 0;
  enqueue.mockClear();
  // The factory caches its driver and `env()` its parse; a fresh import of the
  // route brings fresh copies of both.
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  process.env = ORIGINAL;
});

async function deliver(driver: 'postmark' | 'local', vars: Record<string, string>, auth?: string) {
  process.env = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    EMAIL_PROVIDER: driver,
    ...vars,
  } as NodeJS.ProcessEnv;

  const { POST } = await import('./route');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Basic ${Buffer.from(`postmark:${auth}`).toString('base64')}`;

  return POST(
    new Request(`https://support.example/api/webhooks/email/${driver}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ MessageID: MESSAGE_ID, Subject: 'Where is my parcel?' }),
    }),
    { params: Promise.resolve({ provider: driver }) },
  );
}

describe('POST /api/webhooks/email/[provider] with the configured driver', () => {
  it('refuses Postmark mail when the deploy has no EMAIL_WEBHOOK_SECRET, and records why', async () => {
    const response = await deliver('postmark', { EMAIL_API_KEY: 'server-token' }, 'anything');

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    expect(writes[0]).toMatchObject({ signatureVerified: false, providerEventId: null });
    expect(writes[0]?.error).toMatch(/EMAIL_WEBHOOK_SECRET is not set/);
  });

  it('queues Postmark mail that presents the configured secret', async () => {
    const response = await deliver(
      'postmark',
      { EMAIL_API_KEY: 'server-token', EMAIL_WEBHOOK_SECRET: 'webhook-secret-value' },
      'webhook-secret-value',
    );

    expect(response.status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatchObject({ signatureVerified: true, providerEventId: MESSAGE_ID });
    expect(writes[0]?.error).toBeNull();
  });

  /** Staging: `local`, NODE_ENV=production, and a URL anybody can post to. */
  it('refuses a post to the local driver in production', async () => {
    const response = await deliver('local', {});

    expect(response.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    expect(writes[0]?.error).toMatch(/only outside NODE_ENV=production/);
  });
});
