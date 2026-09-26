import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { stubFetch } from '@/lib/testing/fetch';
import { removeObjects, signedUrl, uploadObject } from './index';

/**
 * Storage is called from worker jobs — where a request with no deadline of its
 * own held every queued job for the five minutes `fetch` waits, since the
 * worker awaits a batch before it claims the next — and from inside a
 * customer's form submission and an agent's page load, where it held the
 * request open instead.
 */

withTestEnv({
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
});

beforeEach(() => {
  // Answers like `fetch` does: a signal that has fired rejects with its reason.
  stubFetch(async (_url: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Response(JSON.stringify({ signedURL: '/object/sign/attachments/x?token=t' }), {
      status: 200,
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The status line arrives; the body is still coming when the deadline passes. */
function stallBody(status: number) {
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

function timeOutEveryRequest() {
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
    AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
  );
}

describe('uploadObject', () => {
  /**
   * A flat minute was sized from a form's 25 MB, and a WhatsApp document can be
   * 100 MB — given up below 1.7 MB/s on every attempt, and dropped for good by
   * email ingest, which does not retry.
   */
  it.each([
    ['an empty file', 0, 60_000],
    ['a small file', 4, 61_000],
    ['a file just over 4 MB', 4 * 1024 * 1024 + 1, 63_000],
  ])('gives %s a minute and a second per 2 MB', async (_what, bytes, expected) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await uploadObject('conversations/c/m.pdf', Buffer.alloc(bytes), 'application/pdf');

    expect(timeout).toHaveBeenCalledWith(expected);
  });

  it('says which object it was writing when the deadline passes', async () => {
    timeOutEveryRequest();

    await expect(
      uploadObject('conversations/c/m.pdf', Buffer.from('%PDF'), 'application/pdf'),
    ).rejects.toThrow('Storage upload of conversations/c/m.pdf did not answer in 61s');
  });

  /** A 2xx is the object stored; waiting on the rest could only undo that. */
  it('reports an object stored once the status says so, whatever the body does', async () => {
    stallBody(200);

    await expect(
      uploadObject('conversations/c/m.pdf', Buffer.from('%PDF'), 'application/pdf'),
    ).resolves.toMatchObject({ path: 'conversations/c/m.pdf', sizeBytes: 4 });
  });

  it('names the object when a refusal stops arriving', async () => {
    stallBody(500);

    await expect(
      uploadObject('conversations/c/m.pdf', Buffer.from('%PDF'), 'application/pdf'),
    ).rejects.toThrow('Storage upload of conversations/c/m.pdf did not answer in 61s');
  });
});

describe('signedUrl', () => {
  it('gives the page that asked ten seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await signedUrl('conversations/c/m.pdf');

    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it('says which object it was signing when the deadline passes', async () => {
    timeOutEveryRequest();

    await expect(signedUrl('conversations/c/m.pdf')).rejects.toThrow(
      'Storage sign of conversations/c/m.pdf did not answer in 10s',
    );
  });

  /** The deadline governs the body too, which rejected with the signal's own reason. */
  it('says the same when the deadline passes while the answer is arriving', async () => {
    stallBody(200);

    await expect(signedUrl('conversations/c/m.pdf')).rejects.toThrow(
      'Storage sign of conversations/c/m.pdf did not answer in 10s',
    );
  });
});

describe('removeObjects', () => {
  const paths = Array.from({ length: 101 }, (_, i) => `conversations/c/${i}.pdf`);

  it('deletes each exact key once in bounded batches, ignoring empty keys', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const exactKey = 'conversations/c/a file.pdf ';

    await expect(removeObjects([...paths, paths[0]!, '', '  ', exactKey])).resolves.toEqual({
      failed: [],
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://project.supabase.co/storage/v1/object/attachments',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer service-role', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths.slice(0, 100) }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://project.supabase.co/storage/v1/object/attachments',
      expect.objectContaining({ body: JSON.stringify({ prefixes: [paths[100], exactKey] }) }),
    );
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
  });

  it.each(['API refusal', 'network error'])(
    'records an %s and still attempts later batches',
    async (failure) => {
      const request = vi.spyOn(globalThis, 'fetch');
      if (failure === 'API refusal') {
        request.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
      } else {
        request.mockRejectedValueOnce(new Error('connection reset'));
      }

      await expect(removeObjects(paths)).resolves.toEqual({ failed: paths.slice(0, 100) });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it('records timed-out keys and still attempts later batches', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );

    await expect(removeObjects(paths)).resolves.toEqual({ failed: paths.slice(0, 100) });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('accepts a successful delete without waiting for its response body', async () => {
    stallBody(200);

    await expect(removeObjects(paths)).resolves.toEqual({ failed: [] });
  });

  it.each([
    ['missing URL', 'SUPABASE_URL', undefined],
    ['missing key', 'SUPABASE_SERVICE_ROLE_KEY', undefined],
    ['invalid URL', 'SUPABASE_URL', 'not a URL'],
  ])('reports all keys when configuration has a %s', async (_what, name, value) => {
    setTestEnv({ [name!]: value });
    const request = vi.spyOn(globalThis, 'fetch');

    await expect(removeObjects([paths[0]!, paths[0]!, '', paths[1]!])).resolves.toEqual({
      failed: paths.slice(0, 2),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('returns immediately for empty keys without requiring storage configuration', async () => {
    // Nothing at all, not only storage's two: `env()` would refuse to parse, so
    // this passing means the empty case never asks it.
    setTestEnv({
      DATABASE_URL: undefined,
      APP_SECRET: undefined,
      SUPABASE_URL: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });
    const request = vi.spyOn(globalThis, 'fetch');

    await expect(removeObjects(['', '  '])).resolves.toEqual({ failed: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
