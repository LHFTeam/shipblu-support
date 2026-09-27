import { HEARTBEAT_TTL_MS } from './eligibility';

/**
 * Whether an unanswered ticket may be taken back from the agent holding it.
 *
 * Pure, and apart from the sweep's queries, for the reason `lib/presence/idle.ts`
 * is: the rule is a comparison of timestamps, and a wrong one is invisible —
 * a ticket that is never reclaimed looks exactly like a team that never
 * leaves. Here it can be tested without a database.
 *
 * The wait is measured from when the agent stopped being available, and each
 * way of stopping has its own clock:
 *
 * - **Gone from the console** — offline, or a heartbeat older than the TTL, or
 *   deactivated — since the last heartbeat.
 * - **Away** — their own switch, a supervisor's or the idle timer's — since the
 *   switch moved. Not since the heartbeat: a console left open beats every 25
 *   seconds whether or not its owner is accepting work, so the heartbeat of an
 *   away agent with a tab open is always seconds old, and a wait measured from
 *   it never ends.
 *
 * When both hold, the earlier start wins: somebody who went away at ten and
 * closed the laptop at eleven has been unavailable since ten. And the wait never
 * starts before the assignment, so a ticket given to somebody already gone
 * still waits the full period before being taken back.
 */
export function reclaimDue(
  holder: {
    isActive: boolean;
    isAcceptingTickets: boolean;
    presence: string;
    lastSeenAt: Date | null;
    acceptingChangedAt: Date | null;
    assignedAt: Date | null;
  },
  waitMins: number,
  now: Date,
): boolean {
  const heartbeat = holder.lastSeenAt?.getTime() ?? 0;
  const disconnected =
    !holder.isActive ||
    holder.presence !== 'online' ||
    heartbeat < now.getTime() - HEARTBEAT_TTL_MS;

  const since: number[] = [];
  if (disconnected) since.push(heartbeat);
  // A switch with no timestamp predates the column; the heartbeat is the only
  // clock it has, which is what the sweep used for every case before.
  if (!holder.isAcceptingTickets) since.push(holder.acceptingChangedAt?.getTime() ?? heartbeat);
  if (since.length === 0) return false;

  const unavailableSince = Math.max(Math.min(...since), holder.assignedAt?.getTime() ?? 0);
  return now.getTime() - unavailableSince >= waitMins * 60_000;
}
