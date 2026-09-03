import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  DEFAULT_POLICY,
  idleForMs,
  idleSince,
  shouldAutoAway,
  shouldRestoreOnInput,
  shouldSignOut,
  validatePolicy,
  warningLeadMs,
  type PresencePolicy,
} from './idle';

/** Wall-clock Cairo, so a fixture reads as the shift it describes. */
function at(time: string, day = '2026-09-03'): Date {
  return DateTime.fromISO(`${day}T${time}`, { zone: 'Africa/Cairo' }).toJSDate();
}

const POLICY: PresencePolicy = { autoAwayAfterMins: 10, autoSignoutAfterMins: 30 };
const OFF: PresencePolicy = { autoAwayAfterMins: null, autoSignoutAfterMins: null };

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
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, POLICY, at('09:30'))).toBe(true);
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, POLICY, at('09:29'))).toBe(false);
  });

  it('never fires while the window is off', () => {
    expect(shouldSignOut({ lastActivityAt: at('09:00') }, OFF, at('23:00'))).toBe(false);
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
