import { z } from 'zod';
import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { suggestFor } from '@/lib/canned-suggest/suggest';
import type { CannedSuggestionAnswer } from '@/lib/canned-suggest/types';
import { readJsonBody } from '@/lib/http/json-body';

export const dynamic = 'force-dynamic';

const body = z.strictObject({ conversationId: z.string().uuid() });

/**
 * The reply composer asking which canned response fits the ticket in front of
 * it — sent when the agent clicks into an empty reply box.
 *
 * A route rather than a server action, because Next sends a client's actions
 * one at a time and a provider call made as one would hold the agent's Send
 * behind it. Not under `/api/kb` or `/api/widget`, which `proxy.ts` leaves
 * public: this one needs the session, and checks it itself.
 *
 * Only the ticket's id comes in. The history Jev is shown and the responses it
 * may choose from are read on the server, with the agent's own visibility —
 * what reaches the third party is never something the browser said.
 *
 * Not rate limited, like `/api/knowledge`: it is behind a session, and the
 * unique index under `suggestFor` already holds the spend to one call per agent
 * per newest message, however often the box is clicked.
 */
export async function POST(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });
  if (!can(agent, 'ticket.reply')) return new Response('forbidden', { status: 403 });

  const parsed = await readJsonBody(request, body);
  if (!parsed) return new Response('bad request', { status: 400 });

  const answer = await suggestFor(agent, parsed.conversationId);
  if (!answer) return new Response('not found', { status: 404 });

  return Response.json(answer satisfies CannedSuggestionAnswer);
}
