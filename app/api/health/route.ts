import { NextResponse } from 'next/server';
import { databaseProbe, poolPressure } from '@/db/client';
import { env } from '@/lib/env';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * How long this endpoint will wait before calling the database unreachable.
 *
 * Well under `DB_QUERY_TIMEOUT_MS`, and that ordering is the point: the query
 * deadline exists to stop a request hanging, while this exists to *report*, and
 * a health check that waits as long as the work it is checking on tells Render
 * nothing it can act on. Clamped rather than asserted, because the deadline is
 * configurable and a five-second constant is only "well under" it by
 * convention — `probeTimeout()` keeps the ordering true by construction.
 */
const PROBE_TIMEOUT_MS = 5_000;

function probeTimeout(): number {
  return Math.min(PROBE_TIMEOUT_MS, env().DB_QUERY_TIMEOUT_MS);
}

/**
 * Fails rather than waits.
 *
 * The `try`/`catch` below only ever caught rejections, and a query parked in
 * postgres.js's queue never rejects — so on 2026-09-08 this route did not return
 * 503, it *hung*, for the same fifty minutes as everything else. Render saw a
 * request it was still waiting on rather than an unhealthy instance, which is
 * why the freeze ran to a full replacement cycle instead of a restart (§62).
 */
async function within<T>(label: string, work: Promise<T>, abandon?: () => void): Promise<T> {
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
          // six times this window, and Render polls this endpoint on a far
          // shorter one — so an endpoint that only raced would contribute a
          // queued query per poll to the saturation it is reporting on.
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
 * Render's health check target. Measures the database round trip because the app
 * and database are colocated in Frankfurt specifically to keep this low — if
 * this number climbs, the colocation assumption has broken.
 *
 * It deliberately shares the ordinary pool rather than holding a connection of
 * its own. A private connection would answer `ok` while every page on the
 * instance was queued behind ten busy slots, which is the opposite of the truth
 * and precisely the failure this endpoint exists to surface.
 */
export async function GET() {
  const started = Date.now();

  try {
    const probe = databaseProbe();
    await within('select 1', probe.done, probe.abandon);
    const dbLatencyMs = Date.now() - started;

    // Left raced rather than made cancellable, because drizzle hands back a
    // `QueryPromise` with no query behind it to cancel. Acceptable here and not
    // above: this runs only once `select 1` has already come back, so the pool
    // was answering a moment ago, and it is a grouped count over a table of a
    // few thousand rows. If it does time out, the query deadline bounds it.
    const queue = await within('queue depth', queueDepth());

    return NextResponse.json({
      status: 'ok',
      dbLatencyMs,
      queue,
      pool: poolPressure(),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'unknown',
        // The number that says whether this is the database or ourselves. A
        // saturated pool with a healthy database is the shape of §62.
        pool: poolPressure(),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
