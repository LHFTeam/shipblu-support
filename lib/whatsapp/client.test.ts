import { afterEach, describe, expect, it, vi } from 'vitest';
import { respondWithGraphError, stubFetch } from '@/lib/testing/fetch';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { STALLED_AFTER_MS } from '@/lib/queue';
import { sizedTimeout } from '@/lib/http/deadline';
import { GRAPH_BASE, graphTimeout } from '@/lib/meta/graph';
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

async function classify(): Promise<WhatsAppApiError> {
  try {
    await getMediaUrl('media-1');
  } catch (error) {
    if (error instanceof WhatsAppApiError) return error;
    throw error;
  }
  throw new Error('expected getMediaUrl to reject');
}

withTestEnv({ META_PAGE_ACCESS_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: '123' });

describe('WhatsApp credentials', () => {
  it('authorises with the shared Meta page token', async () => {
    // The substantive half of collapsing the two credential sets: WhatsApp now
    // sends with the same token Messenger and Instagram do. Asserting on the
    // header rather than on the absence of the old variable is what proves the
    // wiring, since a missing token would also just throw.
    const fetchMock = stubFetch(async () => new Response(JSON.stringify({ url: 'https://cdn' })));

    setTestEnv({ META_PAGE_ACCESS_TOKEN: 'page-token-abc' });

    await getMediaUrl('media-1');

    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer page-token-abc');
  });

  it('refuses to call Meta with no token rather than sending an unauthorised request', async () => {
    setTestEnv({ META_PAGE_ACCESS_TOKEN: undefined });

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
    const fetchMock = stubFetch(
      async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })),
    );

    await sendText('20100', 'hello', { token: 'saudi-token', phoneNumberId: '999' });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/999/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer saudi-token');
  });

  it('lists the templates of the business account it is given', async () => {
    const fetchMock = stubFetch(async () => new Response(JSON.stringify({ data: [] })));

    await listTemplates({ wabaId: '777', token: 'saudi-token' });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain('/777/message_templates');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer saudi-token');
  });

  /** Media is addressed by id, so it must not need a number configured. */
  it('downloads media with no phone number id set at all', async () => {
    setTestEnv({ WHATSAPP_PHONE_NUMBER_ID: undefined });
    stubFetch(async () => new Response(JSON.stringify({ url: 'https://cdn' })));

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
    respondWithGraphError(400, 4, 'Application request limit reached');
    expect((await classify()).isTransient).toBe(true);

    respondWithGraphError(500, null, 'Internal error');
    expect((await classify()).isTransient).toBe(true);

    respondWithGraphError(429, null, 'Too many requests');
    expect((await classify()).isTransient).toBe(true);
  });

  it('does not retry a failure that describes the request itself', async () => {
    // 131047 is the re-engagement rejection and 132001 an unknown template:
    // both fail identically on every attempt, so the agent should see them now.
    respondWithGraphError(
      400,
      131047,
      'Message failed to send because more than 24 hours have passed',
    );
    expect((await classify()).isTransient).toBe(false);

    respondWithGraphError(400, 132001, 'Template name does not exist');
    expect((await classify()).isTransient).toBe(false);
  });

  it('keeps the raw body when Meta answers with a non-JSON error page', async () => {
    stubFetch(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

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
    stubFetch(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify(body), { status: 200 });
    });
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
   * The whole media job, computed from the deadlines its calls actually get:
   * the lookup, the largest download, and `uploadObject`'s upload of the same
   * bytes. Raising the largest size or the per-MB allowance, or lowering the
   * reclaim window, fails here rather than in a job reclaimed mid-upload that
   * writes a second attachment row.
   */
  it('fits the lookup, the largest download and its upload inside the reclaim window', () => {
    const largest = 100 * 1024 * 1024;
    const job = graphTimeout('GET') + mediaTimeout(null) + sizedTimeout(largest);

    expect(mediaTimeout(null)).toBe(mediaTimeout(largest));
    expect(job).toBeLessThanOrEqual(STALLED_AFTER_MS);
  });

  it('releases the connection a refused download holds', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    stubFetch(async () => {
      const response = new Response('denied', { status: 403 });
      Object.defineProperty(response, 'body', { value: { cancel } });
      return response;
    });

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

/**
 * Graph answers in JSON, so a complete 2xx body that is empty, not JSON, or
 * JSON without a message id is somebody else answering in Meta's place — an
 * edge page, a portal, a proxy. Each is retried as a named WhatsApp error. It
 * used to escape as a bare SyntaxError or "no message id"; recording it as
 * "sent" instead would drop a reply that probably never left, with nothing on
 * the row to say so. Only a body cut short after the status (above) is sent.
 */
describe('a 2xx whose complete body is not a Graph answer', () => {
  function answer(body: string) {
    stubFetch(async () => new Response(body, { status: 200 }));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['HTML', '<html>OK</html>', /not a JSON object/],
    ['an empty body', '', /an empty body/],
    ['a bare JSON value', 'null', /not a JSON object/],
  ])('retries a send answered with %s rather than calling it sent', async (_what, body, reason) => {
    answer(body);

    const failure = sendText('201000000000', 'hello');

    await expect(failure).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true, status: 200 });
    await expect(failure).rejects.toThrow(reason);
  });

  it('retries a send answered without a message id, naming keys but not the number', async () => {
    answer(JSON.stringify({ contacts: [{ input: '201000000000', wa_id: '201000000000' }] }));

    const failure = sendText('201000000000', 'hello');

    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow('without a message id (keys: contacts)');
    await expect(failure).rejects.not.toThrow(/201000000000/);
  });

  it('retries a lookup answered with HTML, as a WhatsApp error rather than a SyntaxError', async () => {
    answer('<html>OK</html>');

    const failure = getMediaUrl('media-1');

    await expect(failure).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(failure).rejects.toMatchObject({ isTransient: true, status: 200 });
    await expect(failure).rejects.toThrow(/not a JSON object/);
  });

  /**
   * An empty page read as `{}` — a last page with no data — so template sync
   * kept the first page and marked every template after it DELETED.
   */
  it('fails a template listing whose next page answers empty, rather than ending it', async () => {
    const pages = [
      JSON.stringify({ data: [{ name: 'a' }], paging: { next: `${GRAPH_BASE}/waba/page2` } }),
      '',
    ];
    stubFetch(async () => new Response(pages.shift() ?? '', { status: 200 }));

    await expect(listTemplates({ wabaId: 'waba' })).rejects.toThrow(/an empty body/);
  });
});
