import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { STALLED_AFTER_MS } from '@/lib/queue';
import { graphTimeout } from '@/lib/meta/graph';
import {
  WhatsAppApiError,
  downloadMedia,
  getMediaUrl,
  listTemplates,
  mediaTimeout,
  sendText,
} from './client';
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

/**
 * WhatsApp runs in jobs, and none of its calls had a deadline of its own:
 * `fetch` gives up only after five minutes without a response, and every
 * queued job waited behind it, because the worker awaits a batch before it
 * claims the next.
 */
describe('WhatsApp deadlines', () => {
  /** Answers like `fetch` does: a signal that has fired rejects with its reason. */
  function serveUnlessAborted(body: unknown) {
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

  it('gives a send the Graph write deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted({ messages: [{ id: 'wamid.1' }] });

    await sendText('201000000000', 'hello');

    expect(timeout).toHaveBeenCalledWith(90_000);
  });

  it('gives a lookup the Graph read deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted({ url: 'https://cdn' });

    await getMediaUrl('media-1');

    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  /**
   * A document can be 100 MB, which a flat minute gave up on below 1.7 MB/s —
   * identically on every attempt, until the job died and the media with it.
   */
  it.each([
    ['an empty file', 0, 60_000],
    ['a 2 MB image', 2 * 1024 * 1024, 61_000],
    ['a 100 MB document', 100 * 1024 * 1024, 110_000],
    ['a file Meta gave no size for', null, 110_000],
  ])('gives %s a minute and a second per 2 MB', async (_what, sizeBytes, expected) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted({});

    await downloadMedia('https://lookaside.fbsbx.com/whatsapp_business/attachments/1', {
      sizeBytes,
    });

    expect(timeout).toHaveBeenCalledWith(expected);
  });

  /**
   * Computed from the deadlines the calls actually get, so raising the largest
   * size or the per-MB allowance fails here rather than in a reclaimed job.
   */
  it('leaves the storage upload after the largest download half the reclaim window', () => {
    const lookupAndDownload = graphTimeout('GET') + mediaTimeout(null);

    expect(mediaTimeout(null)).toBe(mediaTimeout(100 * 1024 * 1024));
    expect(lookupAndDownload).toBeLessThanOrEqual(STALLED_AFTER_MS / 2);
  });

  it('releases the connection a refused download holds', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('denied', { status: 403 });
        Object.defineProperty(response, 'body', { value: { cancel } });
        return response;
      }),
    );

    await expect(downloadMedia('https://lookaside.fbsbx.com/1')).rejects.toThrow(/\(403\)/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  /**
   * Recorded on the message row, where the agent reads it, and retried: a send
   * that timed out may still arrive, and is not a reason to give up on it.
   */
  it('turns a send whose deadline passed into a retryable error that says so', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    serveUnlessAborted({});

    const failure = sendText('201000000000', 'hello');

    await expect(failure).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow(/did not answer in 90s/);
  });
});

/**
 * The signal governs reading the body as well as waiting for the status. A
 * deadline passing mid-body rejected with the signal's own reason — not a
 * `WhatsAppApiError`, naming no call — and on a send Meta had accepted, the
 * handler marked the message failed and the queue sent it again.
 */
describe('a deadline that passes while the body is arriving', () => {
  /** The status line arrives; the body is still coming when the deadline passes. */
  function stallBody(status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
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
      ),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a send Meta accepted as sent, rather than sending it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stallBody(200);

    await expect(sendText('201000000000', 'hello')).resolves.toEqual({
      wamid: null,
      recipientId: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/accepted with 200/));
  });

  it('retries a refusal whose reason never arrived, keeping its status', async () => {
    stallBody(400);

    const failure = sendText('201000000000', 'hello');

    await expect(failure).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true, status: 400 });
    await expect(failure).rejects.toThrow(/refused with 400, and its reason never arrived/);
  });

  it('retries a lookup, and says the deadline passed', async () => {
    stallBody(200);

    const failure = getMediaUrl('media-1');

    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow('WhatsApp API did not answer in 15s');
  });

  it('names a media download that stalled mid-read', async () => {
    stallBody(200);

    const failure = downloadMedia('https://lookaside.fbsbx.com/whatsapp_business/attachments/1', {
      sizeBytes: 0,
    });

    await expect(failure).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow('Media download did not answer in 60s');
  });
});
