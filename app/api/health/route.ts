import { NextResponse } from 'next/server';
import { checkReadiness } from '@/lib/health/readiness';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Do not flush a successful status until this instance finishes a DB-backed render. */
export async function GET() {
  const result = await checkReadiness();
  return NextResponse.json(
    {
      status: result.ok ? 'ok' : 'error',
      renderLatencyMs: result.renderLatencyMs,
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      timestamp: result.checkedAt,
    },
    { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
