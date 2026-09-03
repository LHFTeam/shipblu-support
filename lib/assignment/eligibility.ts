/**
 * Who may be handed the next ticket, and — when nobody may — why not.
 *
 * The decision is pure. Rows in, agent ids out, no database. Every reason an
 * agent is passed over reads in one place, and the tests can build a team of
 * five with a stale heartbeat and a full inbox without a Postgres.
 */

export type CandidateRow = {
  agentId: string;
  name: string;
  presence: 'online' | 'away' | 'offline';
  lastSeenAt: Date | null;
  isAcceptingTickets: boolean;
  /** The agent's own cap. Null falls through to the group's. */
  maxOpenTickets: number | null;
  /**
   * Tickets they hold on an `open` status. The only ones the cap counts.
   *
   * See `capacityBacklog()` in `lib/tickets/backlog.ts` for why a pending ticket
   * is not one of them.
   */
  openTickets: number;
  /** Everything they hold, pending included. What load balancing reads. */
  heldTickets: number;
  skillIds: string[];
};

export type Candidate = {
  agentId: string;
  name: string;
  /**
   * Their total load, pending included — deliberately not the figure the cap
   * was tested against.
   *
   * The two questions differ. "May this person be given more?" is about work
   * they can act on now, so it ignores a ticket that is waiting on the customer.
   * "Which of these people should get it?" is about who is carrying least, and a
   * pending ticket is still theirs to pick back up — an agent holding thirty of
   * them and nothing open is not the emptiest pair of hands in the room.
   */
  heldTickets: number;
};

/**
 * How stale a heartbeat may get before the agent counts as gone.
 *
 * The SSE stream refreshes `last_seen_at` every 25 seconds, so this is four
 * missed beats. It exists because `presence` is a *latch*: an instance killed
 * mid-stream never runs its abort handler and leaves the row reading `online`
 * forever. Reading the timestamp as well means that heals itself in two minutes
 * with no reaper job and no lock on `agents`, which this project has been bitten
 * by before.
 */
export const HEARTBEAT_TTL_MS = 2 * 60 * 1000;

export type Rejection = 'offline' | 'not_accepting' | 'missing_skill' | 'at_capacity';

export type Eligibility = {
  eligible: Candidate[];
  /** How many members fell at each hurdle. Empty when everyone got through. */
  rejected: Record<Rejection, number>;
};

/**
 * The agent's cap: their own, else the group's, else none.
 *
 * Two levels rather than one because the two mean different things. A group
 * default is a statement about the work — chat needs a smaller number than email
 * — and an agent's own is a statement about the person, a new starter or someone
 * back from leave. Either can be absent, and absent means uncapped rather than
 * zero: a cap nobody set must never stop the queue.
 *
 * The number is compared against the agent's `open` tickets alone, not against
 * everything they hold — see `capacityBacklog()` in `lib/tickets/backlog.ts`.
 */
export function effectiveCap(
  agentMax: number | null | undefined,
  groupDefault: number | null | undefined,
): number | null {
  if (typeof agentMax === 'number') return agentMax;
  if (typeof groupDefault === 'number') return groupDefault;
  return null;
}

/**
 * Filter the group's roster down to who can take this ticket.
 *
 * The order of the tests is the order the reasons are worth hearing. "Nobody was
 * online" and "everybody was full" are different problems with different fixes —
 * one is a rota, the other is a number in a settings form — so an agent who is
 * both offline and full is counted as offline, which is the fact that came
 * first.
 */
export function filterCandidates(
  rows: CandidateRow[],
  opts: {
    requiredSkillIds: string[];
    groupDefaultMaxOpen: number | null;
    now?: Date;
  },
): Eligibility {
  const now = opts.now ?? new Date();
  const freshAfter = now.getTime() - HEARTBEAT_TTL_MS;
  const required = new Set(opts.requiredSkillIds);

  const eligible: Candidate[] = [];
  const rejected: Record<Rejection, number> = {
    offline: 0,
    not_accepting: 0,
    missing_skill: 0,
    at_capacity: 0,
  };

  for (const row of rows) {
    if (row.presence !== 'online' || !row.lastSeenAt || row.lastSeenAt.getTime() < freshAfter) {
      rejected.offline += 1;
      continue;
    }

    if (!row.isAcceptingTickets) {
      rejected.not_accepting += 1;
      continue;
    }

    // Every required skill, not any of them. A ticket that needs Arabic *and*
    // customs clearance is not served by somebody who has one of the two.
    if (required.size > 0) {
      const held = new Set(row.skillIds);
      let missing = false;
      for (const skillId of required) {
        if (!held.has(skillId)) {
          missing = true;
          break;
        }
      }
      if (missing) {
        rejected.missing_skill += 1;
        continue;
      }
    }

    const cap = effectiveCap(row.maxOpenTickets, opts.groupDefaultMaxOpen);
    if (cap !== null && row.openTickets >= cap) {
      rejected.at_capacity += 1;
      continue;
    }

    eligible.push({ agentId: row.agentId, name: row.name, heldTickets: row.heldTickets });
  }

  return { eligible, rejected };
}
