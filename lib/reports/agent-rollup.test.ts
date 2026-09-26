import { describe, expect, it } from 'vitest';
import type { HoursConfig } from '@/lib/hours';
import { cairo, inCairo } from '@/lib/testing/time';
import { attributeReopen, emptyDay, shiftWindow, withActivity } from './agent-rollup';

const CAIRO = 'Africa/Cairo';

function schedule(overrides: Partial<HoursConfig> = {}): HoursConfig {
  return {
    timezone: CAIRO,
    schedule: {
      sun: [{ start: '09:00', end: '17:00' }],
      mon: [{ start: '09:00', end: '17:00' }],
      tue: [{ start: '09:00', end: '17:00' }],
      wed: [{ start: '09:00', end: '17:00' }],
      thu: [{ start: '09:00', end: '17:00' }],
      fri: [],
      sat: [],
    },
    ...overrides,
  };
}

function on(day: string): Date {
  return cairo(`${day}T00:00`);
}

/** 2026-08-20 is a Thursday; 2026-08-21 a Friday, which this schedule is shut. */
const THURSDAY = '2026-08-20';
const FRIDAY = '2026-08-21';

describe('shiftWindow', () => {
  it('reads the day the schedule opens and closes', () => {
    const shift = shiftWindow([schedule()], on(THURSDAY));

    expect(shift).not.toBeNull();
    expect(inCairo(shift!.start)).toBe(`${THURSDAY}T09:00`);
    expect(inCairo(shift!.end)).toBe(`${THURSDAY}T17:00`);
  });

  it('is null on a day the schedule is closed', () => {
    // The one that matters: a null window is what stops the report calling
    // somebody "late by a whole day" for not working their day off.
    expect(shiftWindow([schedule()], on(FRIDAY))).toBeNull();
  });

  it('is null on a holiday', () => {
    const hours = schedule({ holidays: [{ date: THURSDAY, nameEn: 'Test holiday' }] });
    expect(shiftWindow([hours], on(THURSDAY))).toBeNull();
  });

  it('spans a lunch break rather than reporting the morning only', () => {
    const split = schedule({
      schedule: {
        ...schedule().schedule,
        thu: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    });

    const shift = shiftWindow([split], on(THURSDAY));
    expect(inCairo(shift!.start)).toBe(`${THURSDAY}T09:00`);
    expect(inCairo(shift!.end)).toBe(`${THURSDAY}T18:00`);
  });

  it('takes the earliest opening when an agent is in several groups', () => {
    // The earliest is the one that had them expected at a desk; measuring
    // against the later would call a punctual agent early and hide lateness.
    const early = schedule({
      schedule: { ...schedule().schedule, thu: [{ start: '08:00', end: '16:00' }] },
    });

    const shift = shiftWindow([schedule(), early], on(THURSDAY));
    expect(inCairo(shift!.start)).toBe(`${THURSDAY}T08:00`);
  });

  it('ignores a group with no schedule at all', () => {
    const shift = shiftWindow([null, schedule()], on(THURSDAY));
    expect(shift).not.toBeNull();
  });

  it('is null when nothing resolves to a schedule', () => {
    expect(shiftWindow([null, null], on(THURSDAY))).toBeNull();
  });
});

describe('withActivity', () => {
  const agent = 'a1b2c3d4-0000-0000-0000-000000000000';

  it('drops an agent who did nothing', () => {
    expect(withActivity([emptyDay(agent)])).toEqual([]);
  });

  it('keeps an agent who was online but touched nothing', () => {
    // Present and idle is a finding, not an absence — it is precisely what the
    // availability half of this report exists to show.
    expect(withActivity([{ ...emptyDay(agent), onlineSeconds: 3600 }])).toHaveLength(1);
  });

  it('keeps an agent who ended the day holding tickets', () => {
    expect(withActivity([{ ...emptyDay(agent), openAtDayEnd: 0 }])).toHaveLength(1);
  });
});

describe('attributeReopen', () => {
  const alice = 'a1b2c3d4-0000-0000-0000-00000000000a';
  const bob = 'a1b2c3d4-0000-0000-0000-00000000000b';

  it('credits the agent who resolved it, from the event snapshot', () => {
    expect(attributeReopen({ resolvedBy: alice }, alice)).toBe(true);
  });

  it('does not credit whoever holds the ticket now', () => {
    // The bug this replaced: keying on `assigneeAgentId` put a reopening on
    // Bob simply because the ticket was handed to him afterwards.
    expect(attributeReopen({ resolvedBy: alice }, bob)).toBe(false);
  });

  it('attributes nothing when an automation resolved it', () => {
    // Null is a real answer. A rule closing a ticket owns that resolution, and
    // guessing an agent would put a customer coming back on somebody who did
    // not close it.
    expect(attributeReopen({ resolvedBy: null }, alice)).toBe(false);
  });

  it('attributes nothing for a ticket resolved before this was recorded', () => {
    expect(attributeReopen({}, alice)).toBe(false);
  });
});
