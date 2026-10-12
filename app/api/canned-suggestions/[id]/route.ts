import { z } from 'zod';
import { getSessionAgent } from '@/lib/auth/session';
import { SUGGESTION_EVENTS, recordSuggestionEvent } from '@/lib/canned-suggest/events';
import { readJsonBody } from '@/lib/http/json-body';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ event: z.enum(SUGGESTION_EVENTS) });

/**
 * The composer reporting what the agent did with a suggestion: it appeared in
 * the reply box, the agent took it, or the agent waved it away.
 *
 * Fire-and-forget from the browser, with `keepalive`, the `/api/focus` shape —
 * nothing in the composer waits on it, and the report is the only reader.
 *
 * No permission beyond the session: the row is matched on the agent as well as
 * the id, so the only suggestions an agent can mark are ones their own composer
 * was given, and somebody else's answers exactly like one that does not exist.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const parsed = await readJsonBody(request, body);
  if (!parsed) return new Response('bad request', { status: 400 });

  const { id } = await context.params;
  const found = await recordSuggestionEvent(agent.id, id, parsed.event);
  if (!found) return new Response('not found', { status: 404 });

  return new Response(null, { status: 204 });
}
