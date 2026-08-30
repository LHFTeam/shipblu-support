import type { Candidate } from './eligibility';

/**
 * How the next ticket is chosen from the agents who could take it.
 *
 * Both strategies share one idea: the candidates form a **ring**, ordered
 * stably, and the group's cursor marks where the last ticket landed. Round robin
 * takes the next seat on the ring; load balancing walks the ring from the same
 * place and takes the first seat that is least loaded. Sharing the ring is what
 * stops load balancing from handing every tie to whoever sorts first — with
 * three idle agents and no ring, alphabetical order alone would give all three
 * tickets to the same person and the setting would look broken.
 */

/**
 * The candidates in ring order, starting immediately after the cursor.
 *
 * Sorted by id rather than by name: a rename must not reshuffle the rota, and
 * two agents can share a display name. The cursor naming somebody who is no
 * longer a candidate — offline, at capacity, moved out of the group — is the
 * normal case rather than an error, and starts the ring at the top.
 */
function ringOrder(candidates: Candidate[], cursorAgentId: string | null): Candidate[] {
  const sorted = [...candidates].sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  if (!cursorAgentId) return sorted;

  const at = sorted.findIndex((candidate) => candidate.agentId === cursorAgentId);
  if (at < 0) return sorted;

  return [...sorted.slice(at + 1), ...sorted.slice(0, at + 1)];
}

/** The next agent in the rota. Null only when there are no candidates. */
export function pickRoundRobin(
  candidates: Candidate[],
  cursorAgentId: string | null,
): string | null {
  return ringOrder(candidates, cursorAgentId)[0]?.agentId ?? null;
}

/**
 * The least loaded agent, ties broken by the rota.
 *
 * The cursor sits *last* in the ring, so the agent who took the previous ticket
 * is picked again only when nobody else is as free — which is the correct answer
 * when they are, and never the accidental one when they are not.
 */
export function pickLoadBalanced(
  candidates: Candidate[],
  cursorAgentId: string | null,
): string | null {
  const ring = ringOrder(candidates, cursorAgentId);
  if (ring.length === 0) return null;

  const fewest = Math.min(...ring.map((candidate) => candidate.openTickets));
  return ring.find((candidate) => candidate.openTickets === fewest)?.agentId ?? null;
}
