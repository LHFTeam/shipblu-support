import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/**
 * How long a health probe will wait before calling what it asked unreachable.
 *
 * Well under `DB_QUERY_TIMEOUT_MS`, and that ordering is the point: the query
 * deadline exists to stop a request hanging, while this exists to *report*, and
 * a health check that waits as long as the work it is checking on tells Render
 * nothing it can act on. Clamped rather than asserted, because the deadline is
 * configurable and a five-second constant is only "well under" it by
 * convention — `probeTimeout()` keeps the ordering true by construction.
 *
 * One budget for every part of `/api/health`, which runs them side by side
 * rather than one after another, so the check as a whole answers inside it.
 */
const PROBE_TIMEOUT_MS = 5_000;

export function probeTimeout(): number {
  return Math.min(PROBE_TIMEOUT_MS, env().DB_QUERY_TIMEOUT_MS);
}

/**
 * Fails rather than waits.
 *
 * A `try`/`catch` only ever catches rejections, and a query parked in
 * postgres.js's queue never rejects — so on 2026-09-08 the health check did not
 * return 503, it *hung*, for the same fifty minutes as everything else. Render
 * saw a request it was still waiting on rather than an unhealthy instance,
 * which is why the freeze ran to a full replacement cycle instead of a restart
 * (§62).
 */
export async function within<T>(label: string, work: Promise<T>, abandon?: () => void): Promise<T> {
  const timeoutMs = probeTimeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Cancel what we are about to stop waiting for, where the caller gave
          // us the means. Losing a race does nothing to a query: it keeps its
          // place in postgres.js's queue for the whole `DB_QUERY_TIMEOUT_MS`,
          // six times this window, and Render polls far more often than that —
          // so a probe that only raced would contribute a queued query per poll
          // to the saturation it is reporting on.
          abandon?.();
          reject(new Error(`${label} did not answer in ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What `/probe` prints when, and only when, it rendered and reached the
 * database. A 200 on its own proves nothing there: an RSC prefetch of a
 * `force-dynamic` route returns one without running the page (§6.2), and a
 * redirect to /login answers 200 carrying somebody else's HTML. Asserting on
 * text only that page produces closes both.
 */
export const RENDER_PROBE_MARKER = 'render probe ok';

/**
 * The header `/api/health` sends and `/probe` requires.
 *
 * `/probe` is public in `proxy.ts` because the health check carries no session,
 * and a public page that runs a query per request is a way for anybody to add
 * load to the pool the check is measuring. So the page answers only a request
 * carrying this value — derived from `APP_SECRET`, so it needs no variable of its
 * own and is the same on every instance of one deployment — and 404s everything
 * else without touching the database.
 */
export const RENDER_PROBE_HEADER = 'x-render-probe';

export function renderProbeToken(): string {
  return createHmac('sha256', env().APP_SECRET).update('render-probe').digest('hex');
}

export function isRenderProbeRequest(value: string | null): boolean {
  if (!value) return false;
  const expected = Buffer.from(renderProbeToken());
  const given = Buffer.from(value);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Renders `/probe` on this same instance, over the loopback.
 *
 * The loopback rather than the public URL because the question is about *this*
 * process: through Render's load balancer the request could land on a healthy
 * sibling and pass for the instance that is wedged. `PORT` is what Render binds
 * the server to; 3000 is `next start`'s default for running it by hand.
 *
 * The fetch is aborted when the budget runs out, so a wedged render does not
 * leave a socket open per poll. That does not stop the render itself, which is
 * why `/probe` bounds its own query with the same budget.
 */
export async function renderProbe(): Promise<void> {
  const controller = new AbortController();
  const url = `http://127.0.0.1:${process.env.PORT ?? '3000'}/probe`;

  const work = (async () => {
    const response = await fetch(url, {
      headers: { [RENDER_PROBE_HEADER]: renderProbeToken() },
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await response.text();

    if (response.status !== 200 || !body.includes(RENDER_PROBE_MARKER)) {
      throw new Error(`render probe answered ${response.status} without the marker`);
    }
  })();

  await within('render probe', work, () => controller.abort());
}
