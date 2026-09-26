import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { signedUrl, uploadObject } from './index';

/**
 * Storage is called from worker jobs — where a request with no deadline of its
 * own held every queued job for the five minutes `fetch` waits, since the
 * worker awaits a batch before it claims the next — and from inside a
 * customer's form submission and an agent's page load, where it held the
 * request open instead.
 */

const ORIGINAL_ENV = process.env;
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  } as NodeJS.ProcessEnv;
  resetEnvCache();

  // Answers like `fetch` does: a signal that has fired rejects with its reason.
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Response(JSON.stringify({ signedURL: '/object/sign/attachments/x?token=t' }), {
      status: 200,
    });
  }) as typeof fetch;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  globalThis.fetch = ORIGINAL_FETCH;
  resetEnvCache();
  vi.restoreAllMocks();
});

/** The status line arrives; the body is still coming when the deadline passes. */
function stallBody(status: number) {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          );
        },
      }),
      { status },
    )) as typeof fetch;
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
