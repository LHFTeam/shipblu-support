import { NextResponse } from 'next/server';
import { getSessionAgent } from '@/lib/auth/session';
import { inboxCounts } from '@/lib/tickets/queries';

export const dynamic = 'force-dynamic';

/**
 * The navigation badge's small read model.
 *
 * Outside the inbox, queue notifications fetch this instead of refreshing the
 * current route. The count therefore stays live without rerunning a report,
 * contact page or admin table for every arriving message.
 */
export async function GET() {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  return NextResponse.json(await inboxCounts(agent), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
