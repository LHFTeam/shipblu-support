import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { requestAssignmentSweep, setAccepting } from '@/lib/assignment/presence';
import { shouldAutoAway, shouldRestoreOnInput, type PresencePolicy } from './idle';

/**
 * Recording that a human did something, and acting on it.
 *
 * The counterpart to `lib/assignment/presence.ts`: that module records that a
 * *connection* exists, this one that somebody is using it. Both idle timers —
 * away and sign-out — are measured from what is written here, and nothing else
 * may write it. A request handler quietly refreshing `last_input_at` because it
 * happens to know who the agent is would make every timer unreachable while
 * leaving the column looking healthy.
 */

/**
 * How often the agent-level clock is actually written.
 *
 * The console beats once a minute while somebody is working, so this changes
 * nothing in normal use — it is a floor under a client that reports every
 * keystroke, whether through a bug or on purpose. The session clock is written
 * every time regardless: it is a primary-key update, and it is the one the
 * sign-out is measured against.
 */
const INPUT_WRITE_THROTTLE_MS = 15_000;

export type ActivityOutcome = {
  /** Whether they are being routed work, after any restore below. */
  accepting: boolean;
  /** True when this beat brought them back from an automatic away. */
  restored: boolean;
};

/**
 * An agent touched the console.
 *
 * Restores an availability the idle timer took away, and only that one: a
 * switch somebody turned off by hand stays off until a person turns it back on
 * (`shouldRestoreOnInput`). Coming back from lunch therefore puts an agent
 * straight back in the rota, while a supervisor's decision survives them
 * jiggling the mouse.
 */
export async function recordInput(agentId: string, now = new Date()): Promise<ActivityOutcome> {
  const rows = await db
    .select({
      lastInputAt: agents.lastInputAt,
      isAcceptingTickets: agents.isAcceptingTickets,
      acceptingOffReason: agents.acceptingOffReason,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const agent = rows[0];
  if (!agent) return { accepting: false, restored: false };

  const stale =
    !agent.lastInputAt || now.getTime() - agent.lastInputAt.getTime() >= INPUT_WRITE_THROTTLE_MS;

  if (stale) {
    await db.update(agents).set({ lastInputAt: now }).where(eq(agents.id, agentId));
  }

  if (!shouldRestoreOnInput(agent)) {
    return { accepting: agent.isAcceptingTickets, restored: false };
  }

  const restored = await setAccepting(agentId, true, 'idle');

  // Somebody who has just come back should pick up what is waiting rather than
  // wait for the next five-minute tick — the same reason their own switch asks
  // for a sweep when they turn it on.
  if (restored) await requestAssignmentSweep();

  return { accepting: true, restored };
}

/**
 * Stop routing work to an agent who has gone quiet.
 *
 * Re-checks the threshold against what the database holds rather than trusting
 * the caller. The browser reports its own idleness so the switch flips promptly
 * instead of at the next sweep, and a report is a claim: the beat that would
 * disprove it is the same one that moved `last_input_at`, so the server can
 * simply ask.
 *
 * Returns whether anything changed, which is what the sweep counts.
 */
export async function applyIdleAway(
  agentId: string,
  policy: PresencePolicy,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({
      presence: agents.presence,
      isAcceptingTickets: agents.isAcceptingTickets,
      lastInputAt: agents.lastInputAt,
      acceptingChangedAt: agents.acceptingChangedAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const agent = rows[0];
  if (!agent || !shouldAutoAway(agent, policy, now)) return false;

  return setAccepting(agentId, false, 'idle');
}
