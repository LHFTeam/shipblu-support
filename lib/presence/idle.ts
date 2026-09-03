/**
 * When somebody has stopped working, decided without a database or a clock.
 *
 * Three things ask this question — the browser counting down to a warning, the
 * endpoint the browser reports to, and the sweep that catches everyone whose
 * browser never got to report anything — and they have to agree, or an agent
 * watches a countdown that never fires or is signed out with no warning at all.
 * So the rules live here, once, as functions over plain values.
 *
 * The whole module rests on one distinction, which is also the easiest thing to
 * get wrong in a hurry: **presence is a connection and idleness is a person**.
 * `agents.last_seen_at` is refreshed every 25 seconds for as long as a tab is
 * open, so measuring idleness from it means nobody is ever idle. Only
 * `last_input_at` — a key, a pointer, a scroll — moves when a human does.
 */

/** Minutes, or null for "this timer is off". */
export type PresencePolicy = {
  autoAwayAfterMins: number | null;
  autoSignoutAfterMins: number | null;
};

/**
 * The two windows an admin can set, in minutes.
 *
 * Both ends are bounds rather than opinions. A window under a minute cannot be
 * met by a beat that fires every minute, so it would mark an agent away between
 * keystrokes; a window over a day is longer than any shift, which makes it
 * indistinguishable from off while looking like it is set.
 */
export const MIN_WINDOW_MINS = 1;
export const MAX_WINDOW_MINS = 24 * 60;

/**
 * What a fresh install enforces, before anybody opens the settings page.
 *
 * Ten minutes to stop routing work, thirty to sign out. They are here rather
 * than in a seed row so there is one copy of each number: a seeded row plus a
 * constant is two answers that agree until somebody edits one.
 */
export const DEFAULT_POLICY: PresencePolicy = {
  autoAwayAfterMins: 10,
  autoSignoutAfterMins: 30,
};

export function minutesToMs(minutes: number): number {
  return minutes * 60_000;
}

/**
 * The instant an agent's idleness is counted from.
 *
 * The **later** of their last input and the last time their availability
 * switch moved, and the second half is what makes a manual override stick. A
 * supervisor turning somebody back on has not made them type anything, so
 * measuring from input alone would let the next sweep — seconds later — park
 * them again on the strength of a keypress from twenty minutes ago. Counting
 * from the override instead gives every deliberate change a full window before
 * the automation is allowed to disagree with it.
 *
 * Null when we have never seen either. That is "unknown", not "idle for ever":
 * an agent who has been connected since before this feature shipped has no
 * recorded input, and treating that as idleness would park the whole team on
 * the first sweep after the deploy.
 */
export function idleSince(agent: {
  lastInputAt: Date | null;
  acceptingChangedAt: Date | null;
}): Date | null {
  const candidates = [agent.lastInputAt, agent.acceptingChangedAt].filter(
    (at): at is Date => at !== null,
  );
  if (candidates.length === 0) return null;

  return new Date(Math.max(...candidates.map((at) => at.getTime())));
}

/** Milliseconds since the last sign of life, or null when there is nothing to measure from. */
export function idleForMs(
  agent: { lastInputAt: Date | null; acceptingChangedAt: Date | null },
  now: Date,
): number | null {
  const since = idleSince(agent);
  if (!since) return null;

  // A clock that has run backwards — a client's, or two instances disagreeing —
  // is zero rather than negative, so nothing downstream reads "idle for -3
  // minutes" as a very large unsigned number.
  return Math.max(0, now.getTime() - since.getTime());
}

/**
 * Whether the idle sweep should stop routing work to this agent.
 *
 * Every clause removes a way this would otherwise fire on somebody it should
 * not:
 *
 * - **Only while the window is set.** Null is off, and off means the sweep does
 *   not touch anybody's switch.
 * - **Only an agent who is connected.** Somebody who is offline is already
 *   ineligible for assignment; parking them as well would leave "not accepting"
 *   set when they next sign in, so their first act of the morning would be to
 *   wonder why they are getting no tickets.
 * - **Only one who is currently accepting.** Otherwise the sweep rewrites an
 *   agent's own `self` reason — or a supervisor's — with `idle` every five
 *   minutes, and returning from lunch would auto-restore an away neither of
 *   them chose.
 * - **Only past the window**, measured from `idleSince` rather than from input
 *   alone.
 */
export function shouldAutoAway(
  agent: {
    presence: 'online' | 'away' | 'offline';
    isAcceptingTickets: boolean;
    lastInputAt: Date | null;
    acceptingChangedAt: Date | null;
  },
  policy: PresencePolicy,
  now: Date,
): boolean {
  if (policy.autoAwayAfterMins === null) return false;
  if (agent.presence !== 'online') return false;
  if (!agent.isAcceptingTickets) return false;

  const idle = idleForMs(agent, now);
  if (idle === null) return false;

  return idle >= minutesToMs(policy.autoAwayAfterMins);
}

/**
 * Whether an agent coming back should have their availability restored.
 *
 * Only an `idle` reason is ever undone, because only `idle` was decided by a
 * timer rather than by a person. `self` and `supervisor` are somebody's
 * decision and stay until somebody undoes them.
 */
export function shouldRestoreOnInput(agent: {
  isAcceptingTickets: boolean;
  acceptingOffReason: 'self' | 'idle' | 'supervisor' | null;
}): boolean {
  return !agent.isAcceptingTickets && agent.acceptingOffReason === 'idle';
}

/**
 * Whether a session has been inactive long enough to be destroyed.
 *
 * Measured against the session's own activity rather than the agent's, so the
 * browser left open at home is signed out while the one being typed on is not.
 */
export function shouldSignOut(
  session: { lastActivityAt: Date },
  policy: PresencePolicy,
  now: Date,
): boolean {
  if (policy.autoSignoutAfterMins === null) return false;

  const idle = Math.max(0, now.getTime() - session.lastActivityAt.getTime());
  return idle >= minutesToMs(policy.autoSignoutAfterMins);
}

/**
 * How long the browser should warn before it signs somebody out.
 *
 * A minute, or a third of the window when the window is shorter than three
 * minutes — a fixed minute against a two-minute timeout would put the warning
 * up almost immediately and leave it there, which reads as broken rather than
 * as a warning. The countdown exists because an unsent reply lives only in the
 * DOM: nothing in this console drafts to storage, so a sign-out with no way to
 * stop it throws away whatever somebody had half-written before they took a
 * phone call.
 */
export function warningLeadMs(policy: PresencePolicy): number {
  if (policy.autoSignoutAfterMins === null) return 0;

  const window = minutesToMs(policy.autoSignoutAfterMins);
  return Math.min(60_000, Math.floor(window / 3));
}

/**
 * The problem with a pair of windows, or null when they are usable.
 *
 * Returned as a message rather than thrown: the caller is a settings form, and
 * every one of these is a thing an admin typed rather than a bug.
 */
export function validatePolicy(policy: PresencePolicy): string | null {
  for (const [label, value] of [
    ['The away window', policy.autoAwayAfterMins],
    ['The sign-out window', policy.autoSignoutAfterMins],
  ] as const) {
    if (value === null) continue;
    if (!Number.isInteger(value)) return `${label} has to be a whole number of minutes.`;
    if (value < MIN_WINDOW_MINS || value > MAX_WINDOW_MINS) {
      return `${label} has to be between ${MIN_WINDOW_MINS} and ${MAX_WINDOW_MINS} minutes, or blank to turn it off.`;
    }
  }

  if (
    policy.autoAwayAfterMins !== null &&
    policy.autoSignoutAfterMins !== null &&
    policy.autoSignoutAfterMins < policy.autoAwayAfterMins
  ) {
    return 'Agents have to be marked away before they are signed out, so the sign-out window cannot be shorter than the away one.';
  }

  return null;
}
