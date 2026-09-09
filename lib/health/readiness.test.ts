import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptsProbe, checkReadiness, probeRender } from './readiness';

const nonce = 'a'.repeat(32);
const html = `<html><body><output data-readiness="${nonce}">ready</output></body></html>`;
const options = { port: 3000, token: 'test', nonce, deadlineMs: 30 };
const response = (body: BodyInit | null, status = 200) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.__shipbluReadiness = undefined;
});

describe('render readiness', () => {
  it('requires complete successful HTML and a fresh marker on the same instance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(html));
    await probeRender({ ...options, fetcher });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/health/render',
      expect.objectContaining({
        redirect: 'manual',
        cache: 'no-store',
      }),
    );
  });

  it.each([
    ['redirect', '', 307],
    ['error status', html, 500],
    ['200 error page', '<html>Something went wrong</html>', 200],
    ['stale response', html.replace(nonce, 'b'.repeat(32)), 200],
    ['truncated body', html.replace('</html>', ''), 200],
    ['oversized body', 'x'.repeat(65 * 1024), 200],
  ])('rejects %s', async (_, body, status) => {
    await expect(
      probeRender({
        ...options,
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, status)),
      }),
    ).rejects.toThrow();
  });

  it('times out before headers, even if a transport ignores abort', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(probeRender({ ...options, fetcher })).rejects.toThrow('deadline');
  });

  it('does not accept 200 plus a marker while the body remains open', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode(html));
      },
    });
    try {
      await expect(
        probeRender({
          ...options,
          fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body)),
        }),
      ).rejects.toThrow('deadline');
    } finally {
      controller.close();
    }
  });

  it('coalesces concurrent probes and briefly caches their completed result', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_, init) => {
      const freshNonce = new Headers(init?.headers).get('x-readiness-nonce')!;
      return response(html.replace(nonce, freshNonce));
    });
    vi.stubGlobal('fetch', fetcher);
    const [a, b] = await Promise.all([checkReadiness(), checkReadiness()]);
    expect(a.ok).toBe(true);
    expect(b).toBe(a);
    await checkReadiness();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects public or malformed internal credentials', () => {
    expect(acceptsProbe(null)).toBe(false);
    expect(acceptsProbe('é'.repeat(64))).toBe(false);
    expect(acceptsProbe('0'.repeat(64))).toBe(false);
    expect(acceptsProbe(globalThis.__shipbluReadiness!.token)).toBe(true);
  });
});
