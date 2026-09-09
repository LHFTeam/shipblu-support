import { randomBytes, timingSafeEqual } from 'node:crypto';

export const RENDER_PROBE_PATH = '/api/health/render';
export const READINESS_DEADLINE_MS = 3_500;
const MAX_PROBE_BYTES = 64 * 1024;
const CACHE_MS = 1_000;

type Readiness = { ok: boolean; renderLatencyMs: number; checkedAt: string };
declare global {
  var __shipbluReadiness:
    | {
        token: string;
        pending?: Promise<Readiness>;
        cached?: { until: number; result: Readiness };
      }
    | undefined;
}

function state() {
  return (globalThis.__shipbluReadiness ??= { token: randomBytes(32).toString('hex') });
}

/** Internal render access is instance-local, never a dashboard-owned secret. */
export function acceptsProbe(token: string | null): boolean {
  const expected = state().token;
  return (
    token !== null &&
    /^[a-f0-9]{64}$/.test(token) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}

/**
 * Check this instance, not APP_URL (which could hit another healthy replica).
 * Neither the host nor the port comes from the incoming request. Check headers,
 * the complete bounded body, and a fresh marker produced *after* the DB read.
 * This still refuses a streamed 200 error/fallback if loading boundaries are
 * added later. Never follow an auth redirect or accept a cached shell.
 */
export async function probeRender({
  port,
  token,
  nonce,
  fetcher = fetch,
  deadlineMs = READINESS_DEADLINE_MS,
}: {
  port: number;
  token: string;
  nonce: string;
  fetcher?: typeof fetch;
  deadlineMs?: number;
}): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid readiness port');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    const response = await fetcher(`http://127.0.0.1:${port}${RENDER_PROBE_PATH}`, {
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'x-readiness-token': token, 'x-readiness-nonce': nonce, accept: 'text/html' },
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.includes('text/html') ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error('Render readiness returned an unexpected response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PROBE_BYTES) {
          await reader.cancel();
          throw new Error('Render readiness response exceeded its limit');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (
      !body.includes(`<output data-readiness="${nonce}">ready</output>`) ||
      !body.includes('</html>')
    ) {
      throw new Error('Render readiness did not complete successfully');
    }
  };
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Render readiness deadline exceeded'));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function checkReadiness(): Promise<Readiness> {
  const shared = state();
  if (shared.pending) return shared.pending;
  if (shared.cached && Date.now() < shared.cached.until)
    return Promise.resolve(shared.cached.result);
  const started = Date.now();
  shared.pending = probeRender({
    port: Number(process.env.PORT ?? 3000),
    token: shared.token,
    nonce: randomBytes(16).toString('hex'),
  })
    .then(
      () => true,
      () => false,
    )
    .then((ok) => {
      const result = {
        ok,
        renderLatencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
      shared.cached = { result, until: Date.now() + CACHE_MS };
      return result;
    })
    .finally(() => {
      shared.pending = undefined;
    });
  return shared.pending;
}
