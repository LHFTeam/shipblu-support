import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { WhatsAppApiError, getMediaUrl, listTemplates, sendText } from './client';
import { ACCESS_TOKEN_CODE } from './errors';

/**
 * `isTransient` is what the worker's handlers branch on, and getting it wrong is
 * not a cosmetic problem: a call classified as permanent has its job consumed
 * and its work discarded, so these cases are about which failures survive.
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

async function classify(): Promise<WhatsAppApiError> {
  try {
    await getMediaUrl('media-1');
  } catch (error) {
    if (error instanceof WhatsAppApiError) return error;
    throw error;
  }
  throw new Error('expected getMediaUrl to reject');
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  process.env.META_PAGE_ACCESS_TOKEN = 'token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEnvCache();
});

describe('WhatsApp credentials', () => {
  it('authorises with the shared Meta page token', async () => {
    // The substantive half of collapsing the two credential sets: WhatsApp now
    // sends with the same token Messenger and Instagram do. Asserting on the
    // header rather than on the absence of the old variable is what proves the
    // wiring, since a missing token would also just throw.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: 'https://cdn' })));
    vi.stubGlobal('fetch', fetchMock);

    process.env.META_PAGE_ACCESS_TOKEN = 'page-token-abc';
    resetEnvCache();

    await getMediaUrl('media-1');

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer page-token-abc');
  });

  it('refuses to call Meta with no token rather than sending an unauthorised request', async () => {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    resetEnvCache();

    await expect(getMediaUrl('media-1')).rejects.toThrow(/META_PAGE_ACCESS_TOKEN/);
  });

  /**
   * With more than one WABA connected, the caller resolves the credential and
   * this module must use the one it was handed. Falling back to the shared
   * token is the failure that is hard to see: it succeeds for whichever account
   * the shared token happens to reach, and fails for the other with an error
   * that reads like a deleted resource rather than the wrong credential.
   */
  it('uses the token and number it is given rather than the environment', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await sendText('20100', 'hello', { token: 'saudi-token', phoneNumberId: '999' });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/999/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer saudi-token');
  });

  it('lists the templates of the business account it is given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await listTemplates({ wabaId: '777', token: 'saudi-token' });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/777/message_templates');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer saudi-token');
  });

  /** Media is addressed by id, so it must not need a number configured. */
  it('downloads media with no phone number id set at all', async () => {
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    resetEnvCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ url: 'https://cdn' }))),
    );

    await expect(getMediaUrl('media-1', { token: 'saudi-token' })).resolves.toMatchObject({
      url: 'https://cdn',
    });
  });
});

describe('WhatsApp error classification', () => {
  it('retries an expired or revoked access token', async () => {
    // The token is rotated by a human, and every attempt before that fails. The
    // job must still be retried so it lands in 'dead' and stays replayable —
    // treating it as permanent threw away media Meta keeps for 30 days.
    respondWith(401, ACCESS_TOKEN_CODE, 'Error validating access token: Session has expired');

    const error = await classify();
    expect(error.code).toBe(ACCESS_TOKEN_CODE);
    expect(error.isTransient).toBe(true);
  });

  it('retries rate limits and platform blips', async () => {
    respondWith(400, 4, 'Application request limit reached');
    expect((await classify()).isTransient).toBe(true);

    respondWith(500, null, 'Internal error');
    expect((await classify()).isTransient).toBe(true);

    respondWith(429, null, 'Too many requests');
    expect((await classify()).isTransient).toBe(true);
  });

  it('does not retry a failure that describes the request itself', async () => {
    // 131047 is the re-engagement rejection and 132001 an unknown template:
    // both fail identically on every attempt, so the agent should see them now.
    respondWith(400, 131047, 'Message failed to send because more than 24 hours have passed');
    expect((await classify()).isTransient).toBe(false);

    respondWith(400, 132001, 'Template name does not exist');
    expect((await classify()).isTransient).toBe(false);
  });

  it('keeps the raw body when Meta answers with a non-JSON error page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    );

    const error = await classify();
    expect(error.code).toBeNull();
    expect(error.message).toContain('Bad Gateway');
    expect(error.isTransient).toBe(true);
  });
});
