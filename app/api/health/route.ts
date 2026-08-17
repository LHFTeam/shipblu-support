import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { queueDepth } from '@/lib/queue';

export const dynamic = 'force-dynamic';

/**
 * Render's health check target. Measures the database round trip because the app
 * and database are colocated in Frankfurt specifically to keep this low — if
 * this number climbs, the colocation assumption has broken.
 */
export async function GET() {
  const started = Date.now();

  try {
    await db.execute(sql`select 1`);
    const dbLatencyMs = Date.now() - started;

    const queue = await queueDepth();

    return NextResponse.json({
      status: 'ok',
      dbLatencyMs,
      queue,
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        error: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
