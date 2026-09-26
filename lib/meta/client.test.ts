import { afterEach, describe, expect, it, vi } from 'vitest';
import { respondWithGraphError, stubFetch } from '@/lib/testing/fetch';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  ACCESS_TOKEN_CODE,
  downloadAttachment,
  latestPagePostId,
  MetaApiError,
  privateReplyToComment,
  replyToComment,
  sendDirectMessage,
} from './client';

/**
 * As in the WhatsApp client, `isTransient` decides whether a handler retries or
 * consumes the job, so a misclassified failure is silently discarded work.
 */

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

withTestEnv({ META_PAGE_ACCESS_TOKEN: 'token', FACEBOOK_PAGE_ID: '456' });

describe('Meta error classification', () => {
  it('retries an expired or revoked page token', async () => {
    respondWithGraphError(
      401,
      ACCESS_TOKEN_CODE,
      'Error validating access token: Session has expired',
    );

    const error = await classify();
    expect(error.code).toBe(ACCESS_TOKEN_CODE);
    expect(error.isTransient).toBe(true);
  });

  it('retries rate limits and platform blips', async () => {
    respondWithGraphError(400, 613, 'Calls to this api have exceeded the rate limit');
    expect((await classify()).isTransient).toBe(true);

    respondWithGraphError(503, null, 'Service unavailable');
    expect((await classify()).isTransient).toBe(true);
  });

  it('does not retry a failure that describes the request itself', async () => {
    // 10 is "this person can no longer be messaged" — a property of the
    // conversation, not of our credentials, and true on every attempt.
    respondWithGraphError(400, 10, 'This message is sent outside of allowed window');
    expect((await classify()).isTransient).toBe(false);
  });

  it('treats an unreachable Graph API as transient', async () => {
    stubFetch(async () => {
      throw new Error('ECONNRESET');
    });

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
    const fetchMock = stubFetch(
      async (_url: URL | string) => new Response(JSON.stringify({ id: 'ok' }), { status: 200 }),
    );
    return { url: () => new URL(String(fetchMock.mock.calls[0]![0])) };
  }

  it('sends Instagram over graph.instagram.com with the Instagram token', async () => {
    // The direct connection. Its token is not interchangeable with the Page's:
    // sending one to the other host is refused, and the refusal names neither.
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_ACCOUNT_ID: '17841448759001625' });

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
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token' });

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
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: undefined, INSTAGRAM_ACCOUNT_ID: '17841448759001625' });

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
    setTestEnv({ INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_ACCOUNT_ID: '17841448759001625' });

    const { url } = captureUrl();
    await replyToComment({ platform: 'instagram', commentId: '18618316756031483', message: 'hi' });

    expect(url().host).toBe('graph.instagram.com');
    expect(url().pathname).toContain('18618316756031483/replies');
  });
});

/**
 * Every Graph call runs in a job or a page, and none had a deadline of its own:
 * `fetch` gives up only after five minutes without a response, and in a job
 * that held every queued job behind it, because the worker awaits a batch
 * before it claims the next.
 */
describe('Graph deadlines', () => {
  /** Answers like `fetch` does: a signal that has fired rejects with its reason. */
  function serveUnlessAborted(body: unknown = { data: [] }) {
    stubFetch(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify(body), { status: 200 });
    });
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

/**
 * The signal governs reading the body as well as waiting for the status, so a
 * deadline can pass after Graph has answered and before its answer has arrived.
 * The body then rejects with the signal's own reason, which named no call and
 * was not a `MetaApiError` — and on a send Meta had accepted, a retry.
 */
describe('a deadline that passes while the body is arriving', () => {
  /** The status line arrives; the body is still coming when the deadline passes. */
  function stallBody(status = 200) {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status },
        ),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a send Meta accepted as sent, rather than sending it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stallBody(200);

    await expect(
      sendDirectMessage({
        platform: 'facebook',
        recipientId: 'psid-1',
        text: 'hi',
        tag: 'RESPONSE',
      }),
    ).resolves.toEqual({ messageId: null, recipientId: null });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/accepted with 200/));
  });

  it('retries a read, and says the deadline passed', async () => {
    stallBody(200);

    const failure = latestPagePostId();

    await expect(failure).rejects.toBeInstanceOf(MetaApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow('Graph API did not answer in 15s');
  });

  it('retries a refusal whose reason never arrived, keeping its status', async () => {
    stallBody(400);

    const failure = sendDirectMessage({
      platform: 'facebook',
      recipientId: 'psid-1',
      text: 'hi',
      tag: 'RESPONSE',
    });

    await expect(failure).rejects.toMatchObject({ isTransient: true, status: 400 });
    await expect(failure).rejects.toThrow(
      'Graph API refused with 400, and its reason never arrived (Graph API did not answer in 90s)',
    );
  });

  it.each([
    ['whole', {}],
    ['streamed against a limit', { maxBytes: 1024 }],
  ])('names an attachment download read %s', async (_how, options) => {
    stallBody(200);

    const failure = downloadAttachment('https://lookaside.fbsbx.com/media/1', options);

    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow('Attachment download did not answer in 60s');
  });
});

/**
 * Meta allows one private reply per comment, ever. A retry after a timeout is
 * refused if the first attempt arrived, in the same shape as a deleted comment,
 * so the agent was told the comment was probably gone about a reply the
 * customer had.
 */
describe('a private reply that timed out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is final, and says it may have been delivered', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    stubFetch(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response('{}', { status: 200 });
    });

    const failure = privateReplyToComment({
      platform: 'facebook',
      commentId: '123_456',
      message: 'We have sent you a message',
    });

    await expect(failure).rejects.toBeInstanceOf(MetaApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: false, status: 0 });
    await expect(failure).rejects.toThrow(/may have been delivered/);
  });

  it('keeps every other failure as it was', async () => {
    respondWithGraphError(500, null);

    await expect(
      privateReplyToComment({ platform: 'facebook', commentId: '123_456', message: 'hi' }),
    ).rejects.toMatchObject({ isTransient: true, status: 500 });
  });

  /** A refusal says Meta did not act, so nothing was delivered and a retry is safe. */
  it('retries a refusal whose reason never arrived', async () => {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status: 400 },
        ),
    );

    await expect(
      privateReplyToComment({ platform: 'facebook', commentId: '123_456', message: 'hi' }),
    ).rejects.toMatchObject({ isTransient: true, status: 400 });
  });
});
