import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  ACCESS_TOKEN_CODE,
  fetchThreadOwner,
  isNotThreadOwner,
  MetaApiError,
  NOT_THREAD_OWNER_SUBCODE,
  releaseThreadControl,
  sendDirectMessage,
  takeThreadControl,
} from './client';

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
  // Cleared rather than merely unset: `process.env` is shared across the whole
  // file, and the one test that sets these decides the host every later test
  // resolves to. Left behind, it would send a Facebook assertion to
  // graph.instagram.com.
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_ACCOUNT_ID;
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

describe('thread control', () => {
  // Typed parameters, so the assertions below can read the URL and the body
  // back off `mock.calls` — a bare `vi.fn(async () => …)` records calls against
  // an empty tuple and every index into it is a type error.
  function capture(body: unknown, status = 200) {
    const fetchMock = vi.fn(
      async (_url: URL | string, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /*
    `recipient` is a bare id on this edge and a `{id: …}` object on every other
    one in this file. The asymmetry is Meta's, and getting it the wrong way
    round returns a cheerful empty payload — which this module would read as
    "the thread is idle" and the console would render as "no app owns this
    conversation".
  */
  it('asks for the thread owner with a bare recipient id', async () => {
    const fetchMock = capture({
      data: [{ thread_owner: { app_id: '42', expiration: 1758000000 } }],
    });

    const reading = await fetchThreadOwner('facebook', 'psid-1');

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v23.0/456/thread_owner');
    expect(url.searchParams.get('recipient')).toBe('psid-1');
    expect(reading.appId).toBe('42');
  });

  it('posts a take against the configured account, with metadata', async () => {
    const fetchMock = capture({ success: true });

    await takeThreadControl('facebook', 'psid-1', 'ticket #7');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v23.0/456/take_thread_control');
    expect(JSON.parse(String(init?.body))).toEqual({
      recipient: { id: 'psid-1' },
      metadata: 'ticket #7',
    });
  });

  /*
    The control endpoints have to reach the same host and account the send does.
    Instagram moved to `graph.instagram.com` with its own token when
    `INSTAGRAM_ACCESS_TOKEN` is set, and taking control on one host to send on
    another would report a successful handover and change nothing.
  */
  it('follows Instagram to its own host, as the send path does', async () => {
    process.env.INSTAGRAM_ACCESS_TOKEN = 'ig-token';
    process.env.INSTAGRAM_ACCOUNT_ID = '789';
    resetEnvCache();

    const fetchMock = capture({ success: true });
    await takeThreadControl('instagram', 'igsid-1');

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.host).toBe('graph.instagram.com');
    expect(url.pathname).toBe('/v23.0/789/take_thread_control');
    expect(url.searchParams.get('access_token')).toBe('ig-token');
  });

  it('releases without naming a target app', async () => {
    const fetchMock = capture({ success: true });

    await releaseThreadControl('facebook', 'psid-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/v23.0/456/release_thread_control');
    expect(JSON.parse(String(init?.body))).toEqual({ recipient: { id: 'psid-1' } });
  });

  /*
    A 200 carrying `success: false` is undocumented, and every caller of these
    writes "control moved" to the database on return. Reporting a handover that
    did not happen is worse than reporting a failure that did.
  */
  it('refuses to call a success: false response a success', async () => {
    capture({ success: false });
    await expect(takeThreadControl('facebook', 'psid-1')).rejects.toThrow(MetaApiError);
  });

  it('recognises the refusal that means "ask instead of taking"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "The action is invalid since it's not the thread owner.",
                code: 100,
                error_subcode: NOT_THREAD_OWNER_SUBCODE,
              },
            }),
            { status: 400 },
          ),
      ),
    );

    const error = await takeThreadControl('facebook', 'psid-1').catch((caught) => caught);
    expect(isNotThreadOwner(error)).toBe(true);

    // Anything else is a real failure and must not be quietly downgraded to a
    // request the current owner may ignore.
    expect(isNotThreadOwner(new MetaApiError('nope', 400, 100, 12345, false))).toBe(false);
  });
});
