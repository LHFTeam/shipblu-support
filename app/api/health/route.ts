import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db, withDeadline } from '@/db/client';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/*
 * Render allows a health check five seconds and counts anything slower as a
 * failure, so every wait below is bounded well inside that. The three run
 * concurrently, which is what keeps the worst case the slowest of them rather
 * than the sum.
 */
const DB_DEADLINE_MS = 2_000;
const QUEUE_DEADLINE_MS = 2_000;
const RENDER_DEADLINE_MS = 3_000;

/**
 * Render's health check target — and the only thing standing between a wedged
 * instance and an outage nobody is woken for.
 *
 * It answers three questions, because on 2026-08-25 the first one answered `ok`
 * for eighty-five minutes while the console and the help centre were both dead:
 *
 *  - Can a route handler reach the database, and how long does the round trip
 *    take? The app and database are colocated in Frankfurt precisely to keep
 *    this at 2–4 ms; if it climbs, the colocation assumption has broken.
 *  - Can a *page* be rendered? See `probeRenderPath` — this is the question that
 *    was missing, and the one a wedged pool actually fails.
 *  - Is the queue readable, and how deep is it?
 *
 * Every failure is a 503, which is deliberate: Render stops routing traffic to
 * an instance after 15 seconds of consecutive failures and restarts it after 60.
 * A wedge that used to need a human now costs about a minute and heals itself.
 */
export async function GET() {
  const [database, renderPath, queue] = await Promise.all([
    attempt(async () => {
      const started = Date.now();
      await withDeadline(db.execute(sql`select 1`), DB_DEADLINE_MS, 'select 1');
      return Date.now() - started;
    }),
    attempt(probeRenderPath),
    attempt(() => withDeadline(queueDepth(), QUEUE_DEADLINE_MS, 'queue depth')),
  ]);

  const body = {
    status: database.ok && renderPath.ok && queue.ok ? 'ok' : 'error',
    dbLatencyMs: database.ok ? database.value : null,
    renderPath: renderPath.ok ? 'ok' : renderPath.error,
    queue: queue.ok ? queue.value : null,
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    timestamp: new Date().toISOString(),
  };

  if (body.status === 'ok') return NextResponse.json(body);

  return NextResponse.json(
    {
      ...body,
      // Named individually rather than as one message, so the log line says
      // which half of the process is broken without anyone re-running the check.
      errors: {
        database: database.ok ? null : database.error,
        renderPath: renderPath.ok ? null : renderPath.error,
        queue: queue.ok ? null : queue.error,
      },
    },
    { status: 503 },
  );
}

/**
 * Renders a page the way a person does: over HTTP, through the real router.
 *
 * A request to ourselves looks like a strange way to ask, and it is the only way
 * that cannot be fooled. Importing the page and calling it would run in this
 * bundle, on this bundle's connections — the ones that stayed healthy through
 * the outage. Going over the loopback exercises whatever process and whatever
 * pool actually serves a render, so it fails for a wedged pool, a wedged render
 * worker, and whatever the next one turns out to be.
 *
 * Loopback rather than `APP_URL` on purpose: the question is whether *this*
 * instance can render, and a request to the public hostname would be answered by
 * any healthy instance behind the load balancer — which is exactly the instance
 * we are not asking about.
 */
async function probeRenderPath(): Promise<'ok'> {
  const port = process.env.PORT ?? '3000';

  const response = await fetch(`http://127.0.0.1:${port}/probe`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(RENDER_DEADLINE_MS),
  });

  // Read the body even when the status is wrong: undici holds the socket open
  // until it is consumed, and a check that runs every few seconds would leak one
  // per failure for as long as the instance stays broken.
  const text = await response.text();

  if (!response.ok) throw new Error(`/probe answered ${response.status}`);
  if (!text.includes('probe ok')) throw new Error('/probe rendered something else');

  return 'ok';
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown' };
  }
}
