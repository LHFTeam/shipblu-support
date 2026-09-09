import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { checkReadiness } from '@/lib/health/readiness';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Observability only — readiness alone decides the status code.
 *
 * `dbLatencyMs` is here for the reason it always was: the app and database are
 * colocated in Frankfurt to keep this at 2–4 ms, and nothing else notices when
 * that stops being true. `renderLatencyMs` cannot stand in for it, being a
 * whole HTTP round trip through a Server Component.
 *
 * Bounded and swallowed, because this endpoint's whole job is to fail fast: a
 * slow database must report `null` here rather than give the health check a
 * second way to hang, which is the failure the readiness probe exists to catch.
 */
async function observations(): Promise<{
  dbLatencyMs: number | null;
  queue: Awaited<ReturnType<typeof queueDepth>> | null;
}> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        await db.execute(sql`select 1`);
        const dbLatencyMs = Date.now() - started;
        return { dbLatencyMs, queue: await queueDepth() };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('observation deadline')), 2_000);
      }),
    ]);
  } catch {
    return { dbLatencyMs: null, queue: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Do not flush a successful status until this instance finishes a DB-backed render. */
export async function GET() {
  const [result, observed] = await Promise.all([checkReadiness(), observations()]);
  return NextResponse.json(
    {
      status: result.ok ? 'ok' : 'error',
      renderLatencyMs: result.renderLatencyMs,
      dbLatencyMs: observed.dbLatencyMs,
      queue: observed.queue,
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      timestamp: result.checkedAt,
    },
    { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
