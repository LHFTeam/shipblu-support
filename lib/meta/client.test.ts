import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  ACCESS_TOKEN_CODE,
  downloadAttachment,
  latestPagePostId,
  MetaApiError,
  replyToComment,
  sendDirectMessage,
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
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  delete process.env.INSTAGRAM_ACCOUNT_ID;
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

describe('which connection a call goes out over', () => {
  /**
   * The URL the client actually requested. Everything about routing is in it:
   * the host says which connection, the `access_token` query parameter says
   * which credential. Both are wrong in ways Graph refuses with a sentence that
   * names neither.
   */
  function captureUrl(): { url: () => URL } {
    const fetchMock = vi.fn(
      async (_url: URL | string) => new Response(JSON.stringify({ id: 'ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return { url: () => new URL(String(fetchMock.mock.calls[0]![0])) };
  }

  it('sends Instagram over graph.instagram.com with the Instagram token', async () => {
    // The direct connection. Its token is not interchangeable with the Page's:
    // sending one to the other host is refused, and the refusal names neither.
    process.env.INSTAGRAM_ACCESS_TOKEN = 'ig-token';
    process.env.INSTAGRAM_ACCOUNT_ID = '17841448759001625';
    resetEnvCache();

    const { url } = captureUrl();
    await sendDirectMessage({
      platform: 'instagram',
      recipientId: 'igsid-1',
      text: 'hello',
      tag: 'RESPONSE',
    });

    expect(url().host).toBe('graph.instagram.com');
    expect(url().searchParams.get('access_token')).toBe('ig-token');
    expect(url().pathname).toContain('17841448759001625/messages');
  });

  it('keeps Facebook on graph.facebook.com with the Page token', async () => {
    // Unchanged by the second connection existing, and it has to be: a Page has
    // no second way to be reached, and the Instagram token cannot address one.
    process.env.INSTAGRAM_ACCESS_TOKEN = 'ig-token';
    resetEnvCache();

    const { url } = captureUrl();
    await sendDirectMessage({
      platform: 'facebook',
      recipientId: 'psid-1',
      text: 'hello',
      tag: 'RESPONSE',
    });

    expect(url().host).toBe('graph.facebook.com');
    expect(url().searchParams.get('access_token')).toBe('token');
  });

  it('falls back to the Page for Instagram when the direct connection is unset', async () => {
    // Every deployment before the second connection existed, and staging today.
    // Unset must mean exactly the old behaviour.
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    process.env.INSTAGRAM_ACCOUNT_ID = '17841448759001625';
    resetEnvCache();

    const { url } = captureUrl();
    await sendDirectMessage({
      platform: 'instagram',
      recipientId: 'igsid-1',
      text: 'hello',
      tag: 'RESPONSE',
    });

    expect(url().host).toBe('graph.facebook.com');
    expect(url().searchParams.get('access_token')).toBe('token');
  });

  it('routes comment operations the same way as messages', async () => {
    // The paths are identical on both hosts, which is exactly why this is easy
    // to get wrong: a comment reply posted to the wrong origin is refused with
    // `100 "Unsupported post request"` — the same sentence as a deleted comment.
    process.env.INSTAGRAM_ACCESS_TOKEN = 'ig-token';
    process.env.INSTAGRAM_ACCOUNT_ID = '17841448759001625';
    resetEnvCache();

    const { url } = captureUrl();
    await replyToComment({ platform: 'instagram', commentId: '18618316756031483', message: 'hi' });

    expect(url().host).toBe('graph.instagram.com');
    expect(url().pathname).toContain('18618316756031483/replies');
  });
});

/**
 * Every Graph call runs in a job or a page, and none had a deadline: in a job,
 * one that never answered stopped the whole queue, because the worker awaits a
 * batch before it claims the next.
 */
describe('Graph deadlines', () => {
  /** Answers like `fetch` does: a signal that has fired rejects with its reason. */
  function serveUnlessAborted(body: unknown = { data: [] }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) throw init.signal.reason;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives a read fifteen seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted();

    await latestPagePostId();

    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it('gives a send the longer write deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted({ message_id: 'm.1' });

    await sendDirectMessage({
      platform: 'facebook',
      recipientId: 'psid-1',
      text: 'hello',
      tag: 'RESPONSE',
    });

    expect(timeout).toHaveBeenCalledWith(90_000);
  });

  it('gives a media download a minute', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted();

    await downloadAttachment('https://lookaside.fbsbx.com/media/1');

    expect(timeout).toHaveBeenCalledWith(60_000);
  });

  it('turns a deadline that passed into a retryable error that says so', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    serveUnlessAborted();

    const failure = latestPagePostId();

    await expect(failure).rejects.toBeInstanceOf(MetaApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow(/did not answer in 15s/);
  });
});
