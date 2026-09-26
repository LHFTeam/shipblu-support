import { z } from 'zod';
import { getSessionAgent } from '@/lib/auth/session';
import { readJsonBody } from '@/lib/http/json-body';
import { recordFocus, releaseFocus } from '@/lib/presence/focus';

export const dynamic = 'force-dynamic';

const beat = z.object({
  conversationId: z.string().uuid(),
  /** True when the page is letting go — hidden, idle, or unmounting. */
  release: z.boolean().optional(),
});

/**
 * The console reporting that an agent is working a ticket.
 *
 * Its own endpoint rather than a server action because it fires every thirty
 * seconds and must be sendable from `visibilitychange` on the way out, where
 * only `sendBeacon` is reliable — and a beacon posts a plain body to a URL.
 *
 * Nothing here trusts the body beyond its shape. The conversation id is checked
 * against the agent's visibility rule inside `recordFocus`, so this cannot be
 * used to write time against a ticket the agent may not open, nor to probe
 * which ids exist.
 */
export async function POST(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const parsed = await readJsonBody(request, beat);
  if (!parsed) return new Response('bad request', { status: 400 });

  const { conversationId, release } = parsed;

  if (release) {
    await releaseFocus(agent.id, conversationId);
    // No visibility check on the way out: releasing only ever closes a row this
    // agent already owns, and refusing would leave it open to go stale instead.
    return new Response(null, { status: 204 });
  }

  const recorded = await recordFocus(agent, conversationId);
  if (!recorded) return new Response('not found', { status: 404 });

  return new Response(null, { status: 204 });
}
