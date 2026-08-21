import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents } from '@/db/schema';
import { enqueue } from '@/lib/queue';

/**
 * Whether an agent is at their desk.
 *
 * The signal is the console's own SSE stream: it is open while somebody has the
 * inbox in front of them and closed when they do not. No separate heartbeat
 * endpoint, no "set yourself to available" ritual to forget — the thing that
 * already proves presence is used to record it.
 *
 * `agents.presence` has exactly one writer, this module, called from exactly one
 * place. The agent's own away switch is a different column
 * (`is_accepting_tickets`) precisely so it is not a second writer here: a manual
 * "away" that the next reconnect silently overwrites is worse than no switch.
 *
 * **Multiple streams are handled by expiry rather than by counting.** An agent
 * with two tabs who closes one is marked offline, and the surviving tab's next
 * beat — at most 25 seconds later — puts them back. Reference counting would
 * need state shared across autoscaled instances to be correct, and being briefly
 * skipped by the rota is a far cheaper error than being permanently online
 * because a counter leaked.
 */

/**
 * A stream opened. Also drains the queue: somebody just arrived for their shift.
 *
 * The sweep is asked for only on a real offline→online transition. A reload
 * reopens the stream and would otherwise ask on every navigation.
 */
export async function goOnline(agentId: string): Promise<void> {
  const arrived = await db
    .update(agents)
    .set({ presence: 'online', lastSeenAt: new Date() })
    .where(and(eq(agents.id, agentId), ne(agents.presence, 'online')))
    .returning({ id: agents.id });

  if (arrived.length === 0) {
    // Already online — a second tab, or a reload. Just move the heartbeat.
    await beat(agentId);
    return;
  }

  await requestSweep();
}

/** A keepalive fired. Re-asserts `online` so a sibling tab closing cannot strand it. */
export async function beat(agentId: string): Promise<void> {
  await db
    .update(agents)
    .set({ presence: 'online', lastSeenAt: new Date() })
    .where(eq(agents.id, agentId));
}

export async function goOffline(agentId: string): Promise<void> {
  await db.update(agents).set({ presence: 'offline' }).where(eq(agents.id, agentId));
}

/**
 * Ask the sweep to look at the unassigned queue now.
 *
 * Without this, a ticket that arrived overnight waits for the next five-minute
 * cron tick after the first agent signs in. With it, the queue drains as the
 * shift starts.
 *
 * The dedupe key carries the current minute, which collapses a whole team
 * arriving at nine o'clock into one job — the sweep considers every unassigned
 * ticket anyway, so thirty of them would do the same work thirty times. It must
 * *not* be a constant: `jobs_dedupe_idx` is unique across every row whatever its
 * status, and completed jobs are kept for seven days, so a fixed key would
 * enqueue once and then silently collapse into a finished row for a week.
 */
async function requestSweep(): Promise<void> {
  const minute = new Date().toISOString().slice(0, 16);

  try {
    await enqueue('assign_sweep', {}, { dedupeKey: `assign_sweep:${minute}`, priority: 50 });
  } catch (error) {
    // Presence is worth recording even when the queue is unreachable; the cron
    // will pick the tickets up on its own schedule.
    console.error('[presence] could not enqueue assign_sweep', error);
  }
}

export { requestSweep as requestAssignmentSweep };
