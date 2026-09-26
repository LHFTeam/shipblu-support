import { z } from 'zod';
import { getSessionAgent, touchSessionActivity } from '@/lib/auth/session';
import { readJsonBody } from '@/lib/http/json-body';
import { applyIdleAway, recordInput } from '@/lib/presence/activity';
import { loadPresencePolicy } from '@/lib/presence/policy';

export const dynamic = 'force-dynamic';

const beat = z.object({
  /** True when the console has decided nobody is there any more. */
  idle: z.boolean().optional(),
});

/**
 * The console reporting whether a human is actually using it.
 *
 * Its own endpoint rather than something folded into the presence stream,
 * because the stream runs the wrong way: it is the server talking, and this is
 * the browser reporting input the server has no other way to observe. A
 * connection proves a tab is open; only this proves somebody is in front of it,
 * and the whole idle policy is measured from the difference.
 *
 * Nothing here trusts the body beyond its shape. `idle` is a hint that lets the
 * away flip happen when the agent stops rather than at the next sweep — the
 * server still re-checks the threshold against `last_input_at`, which this same
 * endpoint is the only writer of, so a client claiming idleness it has not
 * earned changes nothing. The opposite claim needs no defence at all: reporting
 * activity is the same as being active.
 *
 * The response carries the availability back, because coming out of an
 * automatic away is a change the agent did not make and has to see — otherwise
 * the header switch says "not accepting" for as long as the page stays open.
 */
export async function POST(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const parsed = await readJsonBody(request, beat);
  if (!parsed) return new Response('bad request', { status: 400 });

  if (parsed.idle) {
    const changed = await applyIdleAway(agent.id, await loadPresencePolicy());
    return Response.json({ accepting: changed ? false : agent.isAcceptingTickets });
  }

  // The session clock and the agent clock are both moved, and they are not the
  // same fact: the session's is per browser, so the laptop being typed on stays
  // signed in while the one left at home does not.
  await touchSessionActivity();
  const outcome = await recordInput(agent.id);

  return Response.json(outcome);
}
