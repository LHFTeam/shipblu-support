import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { goOffline, setAccepting } from '@/lib/assignment/presence';
import { agentsWithLiveSessions, deleteSessionsIdleSince } from '@/lib/auth/session';
import { shouldAutoAway, signOutCutoff } from '@/lib/presence/idle';
import { loadPresencePolicy } from '@/lib/presence/policy';

/**
 * Apply the idle policy to everybody the console could not report on.
 *
 * The browser reports its own idleness, which covers the ordinary case and
 * covers it promptly. This is the half that catches everything a browser cannot
 * say anything about, and each case is real:
 *
 *  - a laptop that went to sleep, or a tab a phone froze
 *  - a machine that lost the network mid-shift
 *  - a console open on an instance that was replaced by a deploy
 *  - a browser that was simply closed without ever going idle
 *
 * Five minutes of granularity, because it rides the sweep that already runs on
 * that schedule rather than booting a container of its own every minute. The
 * away flip is therefore *up to* five minutes late when the browser never got
 * to report it — and never late in the case that actually happens, which is
 * somebody walking away from an open tab.
 *
 * Nothing here is authoritative about sign-out. `getSessionAgent()` refuses an
 * inactive session on the next request whatever this job has or has not done;
 * deleting the row is what stops an abandoned console going on beating its
 * owner into the rota until somebody touches it.
 */
export async function presenceSweep(): Promise<void> {
  const policy = await loadPresencePolicy();

  if (policy.autoAwayAfterMins === null && policy.autoSignoutAfterMins === null) {
    console.log('[presence_sweep] both windows are off, nothing to do');
    return;
  }

  const now = new Date();

  // --- Stop routing work to agents who have gone quiet -----------------------
  // Read the roster and decide in TypeScript rather than in one UPDATE with the
  // predicate inlined. The rule is `greatest(last_input_at, accepting_changed_at)
  // < now - window`, which is exactly the sort of expression that type-checks,
  // passes every test — Vitest runs without a database — and is then wrong in a
  // way nobody sees, because an agent who is quietly never parked looks the same
  // as a team that is never idle. `shouldAutoAway` is the one copy of it, shared
  // with the endpoint the browser reports to, and it has tests.
  let parked = 0;

  if (policy.autoAwayAfterMins !== null) {
    const roster = await db
      .select({
        id: agents.id,
        presence: agents.presence,
        isAcceptingTickets: agents.isAcceptingTickets,
        lastInputAt: agents.lastInputAt,
        acceptingChangedAt: agents.acceptingChangedAt,
      })
      .from(agents)
      .where(eq(agents.isActive, true));

    for (const agent of roster) {
      if (!shouldAutoAway(agent, policy, now)) continue;
      if (await setAccepting(agent.id, false, 'idle')) parked += 1;
    }
  }

  // --- Sign out sessions nobody has touched ---------------------------------
  // `signOutCutoff` answers null both when the timer is off and while a
  // just-enabled window is still inside its grace period — without that second
  // case, the first sweep after an admin switches the sign-out on would find
  // every session in the table already older than the window and destroy the
  // lot.
  const cutoff = signOutCutoff(policy, now);
  let signedOut: string[] = [];

  if (cutoff) {
    signedOut = await deleteSessionsIdleSince(cutoff);

    // Asked once for the whole batch. A deploy or an overnight sweep signs out
    // the entire fleet at once, and a query per agent would be forty round
    // trips on the same five-minute cron as the SLA and assignment sweeps.
    const stillHere = await agentsWithLiveSessions(signedOut);

    for (const agentId of signedOut) {
      // An agent with another live session — a phone, a second machine — is
      // still here, and marking them offline would take them out of the rota
      // for a browser they had already stopped using.
      if (stillHere.has(agentId)) continue;

      // The stream on the other end notices the missing session within 25
      // seconds and signs off by itself. This covers the case where nothing is
      // listening any more: an instance replaced by a deploy leaves an interval
      // open and a presence column saying online, and without this the
      // dashboard shows a full team all night.
      await goOffline(agentId);
    }
  }

  console.log(`[presence_sweep] parked=${parked} sessions_signed_out=${signedOut.length}`);
}
