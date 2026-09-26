import { getSessionAgent } from '@/lib/auth/session';
import { listInbox } from '@/lib/tickets/inbox';
import { parseFilters, parseInboxCursor } from '@/lib/tickets/inbox-filters';

export const dynamic = 'force-dynamic';

/**
 * Older pages of the inbox list, for infinite scroll.
 *
 * The first page still arrives server-rendered with the page itself — this only
 * serves what the agent scrolls to, so the initial paint keeps costing one
 * render and no round trip.
 *
 * Filters are re-parsed from the query string through the same `parseFilters`
 * the page uses, and the rows come from the same `listInbox`. That is
 * deliberate: visibility (whose tickets, which channels) is decided inside the
 * query from the session, so this endpoint cannot widen what an agent sees by
 * asking differently. A forged `channel=whatsapp_bot` returns nothing here for
 * exactly the reason it returns nothing on the page.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const { searchParams } = new URL(request.url);

  const cursor = parseInboxCursor(searchParams.get('cursor'));
  // A cursor that did not decode is a bad request rather than a first page:
  // silently serving the newest rows again would append duplicates to the list
  // the agent is already looking at.
  if (!cursor) return new Response('a valid cursor is required', { status: 400 });

  const filters = parseFilters(Object.fromEntries(searchParams));
  const { rows, nextCursor } = await listInbox(agent, filters, cursor);

  return Response.json({ rows, nextCursor });
}
