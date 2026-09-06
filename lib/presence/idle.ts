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
 * The policy as stored, plus when it last changed.
 *
 * `changedAt` exists for one reason, and it is the same reason
 * `agents.accepting_changed_at` exists: a window that has just been *turned on*
 * finds every session in the table already older than it. Nothing beats while
 * both timers are off — the console does not even attach its listeners — so the
 * first sweep after an admin enables the sign-out would destroy every session at
 * once, with no countdown, because the consoles rendered before the change do
 * not know a countdown is now a thing. Measuring from the later of the session's
 * own activity and this gives the whole fleet one full window to prove somebody
 * is there.
 *
 * Null means "no row yet", which is a fresh install: the column defaults on
 * `sessions.last_activity_at` already start every session's clock at the
 * migration, so there is nothing to grant a grace against.
 *
 * The away timer deliberately has no equivalent. Being parked is undone by a
 * keypress and costs nobody their unsent work, so enabling it mid-shift and
 * parking whoever is genuinely idle is the correct outcome rather than a
 * surprise.
 */
export type StoredPresencePolicy = PresencePolicy & { changedAt: Date | null };

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
 * The instant a session must have been active since to survive, or null when
 * nothing may be signed out at all.
 *
 * Null covers both "the timer is off" and "the timer was only just turned on",
 * and the sweep leans on the second: because the answer is one instant for the
 * whole fleet, a policy still inside its grace period means the sweep has
 * nothing to do rather than something to filter row by row.
 */
export function signOutCutoff(policy: StoredPresencePolicy, now: Date): Date | null {
  if (policy.autoSignoutAfterMins === null) return null;

  const cutoff = now.getTime() - minutesToMs(policy.autoSignoutAfterMins);
  if (policy.changedAt !== null && policy.changedAt.getTime() > cutoff) return null;

  return new Date(cutoff);
}

/**
 * Whether a session has been inactive long enough to be destroyed.
 *
 * Measured against the session's own activity rather than the agent's, so the
 * browser left open at home is signed out while the one being typed on is not.
 */
export function shouldSignOut(
  session: { lastActivityAt: Date },
  policy: StoredPresencePolicy,
  now: Date,
): boolean {
  const cutoff = signOutCutoff(policy, now);

  // Inclusive, and it has to match the sweep's `lte` exactly: "idle for the
  // window" is over the line, and the request path and the sweep disagreeing by
  // a millisecond about that is a difference nothing would ever explain.
  return cutoff !== null && session.lastActivityAt.getTime() <= cutoff.getTime();
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
 * The two clocks the console's timer runs against, as durations.
 *
 * Durations rather than instants because one of them is not this machine's to
 * measure: `session` is how idle the *server* holds this session to be, and a
 * browser handed an instant would compare it against a clock that need not
 * agree. A duration survives the difference.
 */
export type IdleClocks = {
  /**
   * Since the last beat the server accepted — which is what
   * `sessions.last_activity_at` holds, and therefore the only thing the
   * inactivity sign-out is ever decided on.
   */
  sessionMs: number;
  /** Since the last key, pointer or scroll this tab saw. */
  inputMs: number;
};

/** What the browser should do this tick. Latches are the caller's. */
export type IdleAction = {
  /** The session is over; leave, and say why. */
  signOut: boolean;
  /** Put the countdown up. */
  warn: boolean;
  /** What it should say, in milliseconds. */
  remainingMs: number;
  /** Tell the server nobody is here. */
  reportIdle: boolean;
};

/**
 * Which timer has come due, given both clocks.
 *
 * Here rather than inside `components/agent-activity.tsx` for the reason the
 * whole module is here — three parties have to agree — and because the thing
 * that went wrong is not arithmetic but *which clock answers which question*,
 * which is exactly what a signature can state and a test can hold.
 *
 * **The sign-out reads `sessionMs`; the away report reads `inputMs`.** They are
 * not interchangeable and the gap between them is a whole beat interval: the
 * console reports at most once a minute, so the server's clock is routinely up
 * to sixty seconds behind the last key. Running the countdown off `inputMs` puts
 * the warning up to a minute after the deadline it is warning about — and the
 * warning is itself only a minute long, so "Stay signed in" would post to a
 * session `getSessionAgent()` had already deleted, and the half-written reply in
 * the box would go with it. That is the exact loss the countdown exists to
 * prevent, so the countdown is measured on the server's clock even though the
 * away report, which is a claim about the person, is not.
 *
 * The caller owns the latches — a warning already on screen, an idle report
 * already sent — because those are facts about this tab rather than about time.
 */
export function idleTick(
  clocks: IdleClocks,
  windows: { signoutMs: number | null; awayMs: number | null; warningLeadMs: number },
): IdleAction {
  const { signoutMs, awayMs } = windows;

  const signOut = signoutMs !== null && clocks.sessionMs >= signoutMs;

  return {
    signOut,
    // Never alongside the sign-out: a dialog raised in the same tick it becomes
    // moot flashes up as the page navigates away.
    warn: !signOut && signoutMs !== null && clocks.sessionMs >= signoutMs - windows.warningLeadMs,
    remainingMs: signoutMs === null ? 0 : Math.max(0, signoutMs - clocks.sessionMs),
    reportIdle: awayMs !== null && clocks.inputMs >= awayMs,
  };
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
