import { describe, expect, it } from 'vitest';
import { cairo } from '@/lib/testing/time';
import {
  DEFAULT_POLICY,
  idleForMs,
  idleSince,
  idleTick,
  shouldAutoAway,
  shouldRestoreOnInput,
  shouldSignOut,
  signOutCutoff,
  validatePolicy,
  warningLeadMs,
  type PresencePolicy,
  type StoredPresencePolicy,
} from './idle';

/** Wall-clock Cairo, so a fixture reads as the shift it describes. */
function at(time: string, day = '2026-09-03'): Date {
  return cairo(`${day}T${time}`);
}

const POLICY: PresencePolicy = { autoAwayAfterMins: 10, autoSignoutAfterMins: 30 };
const OFF: PresencePolicy = { autoAwayAfterMins: null, autoSignoutAfterMins: null };

/** A policy that has been in force long enough for its grace to have elapsed. */
function settled(policy: PresencePolicy = POLICY): StoredPresencePolicy {
  return { ...policy, changedAt: at('00:00') };
}

function online(over: Partial<Parameters<typeof shouldAutoAway>[0]> = {}) {
  return {
    presence: 'online' as const,
    isAcceptingTickets: true,
    lastInputAt: at('09:00'),
    acceptingChangedAt: null,
    ...over,
  };
}

describe('idleSince', () => {
  it('takes the later of input and the last availability change', () => {
    expect(idleSince({ lastInputAt: at('09:00'), acceptingChangedAt: at('09:40') })).toEqual(
      at('09:40'),
    );
    expect(idleSince({ lastInputAt: at('10:00'), acceptingChangedAt: at('09:40') })).toEqual(
      at('10:00'),
    );
  });

  it('is null when neither has ever been recorded', () => {
    expect(idleSince({ lastInputAt: null, acceptingChangedAt: null })).toBeNull();
  });

  it('reads zero rather than negative when a clock has run backwards', () => {
    expect(idleForMs({ lastInputAt: at('09:05'), acceptingChangedAt: null }, at('09:00'))).toBe(0);
  });
});

describe('shouldAutoAway', () => {
  it('parks an agent who has not touched anything for the window', () => {
    expect(shouldAutoAway(online(), POLICY, at('09:10'))).toBe(true);
  });

  it('leaves them alone one minute short of it', () => {
    expect(shouldAutoAway(online(), POLICY, at('09:09'))).toBe(false);
  });

  it('does nothing at all while the window is off', () => {
    expect(shouldAutoAway(online(), OFF, at('17:00'))).toBe(false);
  });

  it('ignores an agent who is not connected', () => {
    // Parking someone who is offline leaves "not accepting" set for the
    // morning, so their first act of the day is wondering why the queue skips
    // them.
    expect(shouldAutoAway(online({ presence: 'offline' }), POLICY, at('09:30'))).toBe(false);
  });

  it('never overwrites a switch that is already off', () => {
    // Otherwise the sweep relabels a supervisor's decision as idleness every
    // five minutes, and the agent's next keypress silently undoes it.
    expect(shouldAutoAway(online({ isAcceptingTickets: false }), POLICY, at('09:30'))).toBe(false);
  });

  it('gives a supervisor who just turned somebody on a full window', () => {
    // The agent's last keypress is old by definition — they are in a meeting —
    // so measuring from input alone would re-park them on the very next sweep.
    const agent = online({ lastInputAt: at('09:00'), acceptingChangedAt: at('09:25') });

    expect(shouldAutoAway(agent, POLICY, at('09:30'))).toBe(false);
    expect(shouldAutoAway(agent, POLICY, at('09:35'))).toBe(true);
  });

  it('leaves an agent with no recorded input alone', () => {
    // Everybody connected across the deploy that added the column looks like
    // this. Reading it as idleness would park the whole team on the first sweep.
    expect(shouldAutoAway(online({ lastInputAt: null }), POLICY, at('17:00'))).toBe(false);
  });
});

describe('shouldRestoreOnInput', () => {
  it('restores an away the timer set', () => {
    expect(shouldRestoreOnInput({ isAcceptingTickets: false, acceptingOffReason: 'idle' })).toBe(
      true,
    );
  });

  it('leaves a decision somebody made', () => {
    expect(shouldRestoreOnInput({ isAcceptingTickets: false, acceptingOffReason: 'self' })).toBe(
      false,
    );
    expect(
      shouldRestoreOnInput({ isAcceptingTickets: false, acceptingOffReason: 'supervisor' }),
    ).toBe(false);
  });

  it('has nothing to do for an agent who is already accepting', () => {
    expect(shouldRestoreOnInput({ isAcceptingTickets: true, acceptingOffReason: null })).toBe(
      false,
    );
  });
});

describe('shouldSignOut', () => {
  it('measures the session, not the agent', () => {
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, settled(), at('09:30'))).toBe(true);
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, settled(), at('09:29'))).toBe(false);
  });

  it('never fires while the window is off', () => {
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, settled(OFF), at('23:00'))).toBe(false);
  });

  it('signs nobody out inside the grace after the window is turned on', () => {
    // The case that would otherwise sign out the whole team at once: nothing
    // beats while the timers are off, so the moment an admin enables the
    // sign-out every session in the table is already older than it.
    const justEnabled: StoredPresencePolicy = { ...POLICY, changedAt: at('09:00') };

    expect(shouldSignOut({ lastActivityAt: at('06:00') }, justEnabled, at('09:01'))).toBe(false);
    expect(shouldSignOut({ lastActivityAt: at('06:00') }, justEnabled, at('09:29'))).toBe(false);
    // …and once a full window has passed since the change, it applies normally.
    expect(shouldSignOut({ lastActivityAt: at('06:00') }, justEnabled, at('09:30'))).toBe(true);
  });

  it('has no grace to give on a fresh install', () => {
    // No row means nobody has changed anything, and the column default already
    // started every session's clock at the migration.
    const noRow: StoredPresencePolicy = { ...POLICY, changedAt: null };
    expect(shouldSignOut({ lastActivityAt: at('06:00') }, noRow, at('09:00'))).toBe(true);
  });
});

describe('signOutCutoff', () => {
  it('is the window back from now once the policy has settled', () => {
    expect(signOutCutoff(settled(), at('10:00'))).toEqual(at('09:30'));
  });

  it('is null while the timer is off, and while the grace still runs', () => {
    expect(signOutCutoff(settled(OFF), at('10:00'))).toBeNull();
    expect(signOutCutoff({ ...POLICY, changedAt: at('09:50') }, at('10:00'))).toBeNull();
  });
});

describe('warningLeadMs', () => {
  it('gives a minute of warning on any ordinary window', () => {
    expect(warningLeadMs(POLICY)).toBe(60_000);
  });

  it('shrinks rather than swallowing a very short window', () => {
    // A fixed minute against a two-minute timeout puts the dialog up almost
    // immediately and leaves it there, which reads as broken.
    expect(warningLeadMs({ autoAwayAfterMins: 1, autoSignoutAfterMins: 2 })).toBe(40_000);
  });

  it('is zero when nothing is going to happen', () => {
    expect(warningLeadMs(OFF)).toBe(0);
  });
});

describe('idleTick', () => {
  /** The production defaults, in the milliseconds the browser works in. */
  const WINDOWS = { signoutMs: 30 * 60_000, awayMs: 10 * 60_000, warningLeadMs: 60_000 };

  it('warns on the session clock, so the countdown outlives the beat throttle', () => {
    // The case that made this a bug rather than a detail. The console beats at
    // most once a minute, so an agent who stops typing at 09:00 may last have
    // been *reported* at 08:59:01 — the server's clock is 59 seconds ahead of
    // theirs. Measured on input, the warning would appear at 09:29 and the
    // server would have destroyed the session at 09:29:01, a second later:
    // "Stay signed in" posts to nothing and the unsent reply is gone.
    const sessionMs = 29 * 60_000; // the server: one minute from the deadline
    const inputMs = sessionMs - 59_000; // the person: still a minute and a bit

    expect(idleTick({ sessionMs, inputMs }, WINDOWS)).toMatchObject({
      signOut: false,
      warn: true,
      remainingMs: 60_000,
    });
  });

  it('signs out on the session clock, not on the last key', () => {
    // Input a minute fresher than the session, which is what the throttle
    // guarantees. The server has already stopped honouring this session, so a
    // browser still counting is a browser about to be surprised by a 401.
    expect(idleTick({ sessionMs: 30 * 60_000, inputMs: 29 * 60_000 }, WINDOWS)).toMatchObject({
      signOut: true,
    });
  });

  it('does not raise a countdown in the tick that signs somebody out', () => {
    // It would flash up and navigate away underneath itself.
    expect(idleTick({ sessionMs: 45 * 60_000, inputMs: 45 * 60_000 }, WINDOWS)).toMatchObject({
      signOut: true,
      warn: false,
    });
  });

  it('reports idleness off the person, not off the session', () => {
    // The other direction, and the reason these are two clocks rather than one:
    // a beat resets the session's clock but says nothing about whether anybody
    // is still there. Somebody who pressed a key ten minutes ago is away even
    // though the beat that carried that key is only nine minutes old.
    expect(idleTick({ sessionMs: 9 * 60_000, inputMs: 10 * 60_000 }, WINDOWS).reportIdle).toBe(
      true,
    );
    expect(idleTick({ sessionMs: 10 * 60_000, inputMs: 9 * 60_000 }, WINDOWS).reportIdle).toBe(
      false,
    );
  });

  it('does nothing at all with both windows off', () => {
    expect(
      idleTick(
        { sessionMs: 12 * 60 * 60_000, inputMs: 12 * 60 * 60_000 },
        { signoutMs: null, awayMs: null, warningLeadMs: 0 },
      ),
    ).toEqual({ signOut: false, warn: false, remainingMs: 0, reportIdle: false });
  });

  it('never counts down past zero', () => {
    // The dialog renders `Math.ceil(remainingMs / 1000)`; a negative would read
    // as "signed out in -3 seconds" in the half-second before the tick fires.
    expect(idleTick({ sessionMs: 31 * 60_000, inputMs: 0 }, WINDOWS).remainingMs).toBe(0);
  });
});

describe('validatePolicy', () => {
  it('accepts the defaults, and either timer switched off', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toBeNull();
    expect(validatePolicy(OFF)).toBeNull();
    expect(validatePolicy({ autoAwayAfterMins: 10, autoSignoutAfterMins: null })).toBeNull();
  });

  it('refuses a sign-out that would arrive before the away', () => {
    // The away state would be unreachable: the session dies first, so nobody is
    // ever seen as away and the reason nobody can work out is a setting.
    expect(validatePolicy({ autoAwayAfterMins: 30, autoSignoutAfterMins: 10 })).toMatch(
      /cannot be shorter/,
    );
  });

  it('allows the two to be equal', () => {
    expect(validatePolicy({ autoAwayAfterMins: 15, autoSignoutAfterMins: 15 })).toBeNull();
  });

  it('refuses a window outside the usable range', () => {
    expect(validatePolicy({ autoAwayAfterMins: 0, autoSignoutAfterMins: 30 })).toMatch(/between/);
    expect(validatePolicy({ autoAwayAfterMins: 10, autoSignoutAfterMins: 2000 })).toMatch(
      /between/,
    );
    expect(validatePolicy({ autoAwayAfterMins: 1.5, autoSignoutAfterMins: 30 })).toMatch(
      /whole number/,
    );
  });
});
