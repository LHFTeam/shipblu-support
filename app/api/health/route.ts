import { NextResponse } from 'next/server';
import { allPoolPressures, databaseProbe } from '@/db/client';
import { renderProbe, within } from '@/lib/health/probe';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * Render's health check target. Measures the database round trip because the app
 * and database are colocated in Frankfurt specifically to keep this low — if
 * this number climbs, the colocation assumption has broken.
 *
 * It deliberately shares the ordinary pool rather than holding a connection of
 * its own. A private connection would answer `ok` while every page on the
 * instance was queued behind ten busy slots, which is the opposite of the truth
 * and precisely the failure this endpoint exists to surface.
 *
 * And it renders a page, because a route handler answering says nothing about
 * whether a Server Component can (`renderProbe`, `app/probe/page.tsx`). The
 * render runs beside `select 1` rather than after it, so adding it costs no
 * time: the pair answers inside one probe window either way. The queue count
 * after them has a window of its own, so the whole check can take up to about
 * two windows; that was already so before the render. When the database is down
 * both fail together, on every instance at once, and restarting then changes
 * nothing — that was already true of `select 1`, and this adds no new way for
 * the check to fail on a healthy instance.
 */
export async function GET() {
  const started = Date.now();

  try {
    const probe = databaseProbe();
    const render = renderProbe().then(() => Date.now() - started);
    // Observed now so a render failure is never an unhandled rejection while
    // `select 1` is still being awaited; it is re-thrown below.
    render.catch(() => {});

    await within('select 1', probe.done, probe.abandon);
    const dbLatencyMs = Date.now() - started;
    const renderMs = await render;

    // Left raced rather than made cancellable, because drizzle hands back a
    // `QueryPromise` with no query behind it to cancel. Acceptable here and not
    // above: this runs only once `select 1` has already come back, so the pool
    // was answering a moment ago, and it is a grouped count over a table of a
    // few thousand rows. If it does time out, the query deadline bounds it.
    const queue = await within('queue depth', queueDepth());

    return NextResponse.json({
      status: 'ok',
      dbLatencyMs,
      renderMs,
      queue,
      // Every pool in the process, not only the one this route handler uses:
      // pages run on a second pool (`db/client.ts`), and that is the one that
      // froze on 2026-09-08 and on 2026-10-11.
      pools: allPoolPressures(),
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'unknown',
        // The numbers that say whether this is the database or ourselves. A
        // saturated pool with a healthy database is the shape of §62, and a
        // pool with `lost` places is the shape of §6.91.
        pools: allPoolPressures(),
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
