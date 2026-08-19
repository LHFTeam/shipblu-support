import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { ACCESS_TOKEN_CODE, MetaApiError, sendDirectMessage } from './client';

/**
 * As in the WhatsApp client, `isTransient` decides whether a handler retries or
 * consumes the job, so a misclassified failure is silently discarded work.
 */

function respondWith(status: number, code: number | null, message = 'nope') {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message, ...(code === null ? {} : { code }) } }), {
          status,
        }),
    ),
  );
}

async function classify(): Promise<MetaApiError> {
  try {
    await sendDirectMessage({
      platform: 'facebook',
      recipientId: 'psid-1',
      text: 'hello',
      tag: 'RESPONSE',
    });
  } catch (error) {
    if (error instanceof MetaApiError) return error;
    throw error;
  }
  throw new Error('expected sendDirectMessage to reject');
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  process.env.META_PAGE_ACCESS_TOKEN = 'token';
  process.env.FACEBOOK_PAGE_ID = '456';
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe('Meta error classification', () => {
  it('retries an expired or revoked page token', async () => {
    respondWith(401, ACCESS_TOKEN_CODE, 'Error validating access token: Session has expired');

    const error = await classify();
    expect(error.code).toBe(ACCESS_TOKEN_CODE);
    expect(error.isTransient).toBe(true);
  });

  it('retries rate limits and platform blips', async () => {
    respondWith(400, 613, 'Calls to this api have exceeded the rate limit');
    expect((await classify()).isTransient).toBe(true);

    respondWith(503, null, 'Service unavailable');
    expect((await classify()).isTransient).toBe(true);
  });

  it('does not retry a failure that describes the request itself', async () => {
    // 10 is "this person can no longer be messaged" — a property of the
    // conversation, not of our credentials, and true on every attempt.
    respondWith(400, 10, 'This message is sent outside of allowed window');
    expect((await classify()).isTransient).toBe(false);
  });

  it('treats an unreachable Graph API as transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const error = await classify();
    expect(error.status).toBe(0);
    expect(error.isTransient).toBe(true);
  });
});
