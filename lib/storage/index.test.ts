import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { signedUrl, uploadObject } from './index';

/**
 * Storage is called from worker jobs — where one request that never answered
 * stopped the whole queue, since the worker awaits a batch before it claims the
 * next — and from inside a customer's form submission and an agent's page load,
 * where it held the request open instead.
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

function timeOutEveryRequest() {
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
    AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
  );
}

describe('uploadObject', () => {
  it('allows a minute for the bytes to arrive', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await uploadObject('conversations/c/m.pdf', Buffer.from('%PDF'), 'application/pdf');

    expect(timeout).toHaveBeenCalledWith(60_000);
  });

  it('says which object it was writing when the deadline passes', async () => {
    timeOutEveryRequest();

    await expect(
      uploadObject('conversations/c/m.pdf', Buffer.from('%PDF'), 'application/pdf'),
    ).rejects.toThrow('Storage upload of conversations/c/m.pdf did not answer in 60s');
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
});
