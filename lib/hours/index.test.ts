import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { WeeklySchedule } from '@/db/schema/config';
import { isWithinBusinessHours, nextOpeningAt, type HoursConfig } from './index';

/** ShipBlu's actual week: Sunday–Thursday, 09:00–17:00 Cairo. */
const CAIRO: WeeklySchedule = {
  sun: [{ start: '09:00', end: '17:00' }],
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [],
  sat: [],
};

const config: HoursConfig = { schedule: CAIRO, timezone: 'Africa/Cairo' };

/**
 * Builds an instant from Cairo wall-clock time.
 *
 * Deliberately not hand-converted to UTC in the test. Egypt reinstated summer
 * time in 2023, so Cairo is UTC+2 in winter and UTC+3 in summer — writing the
 * offsets by hand is how a test ends up asserting the wrong thing and passing
 * against a bug. Letting the timezone database do it means these read as the
 * team's own hours.
 */
function at(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: 'Africa/Cairo' });
  if (!dt.isValid) throw new Error(`bad test date: ${iso}`);
  return dt.toJSDate();
}

/** The inverse, for asserting on a returned instant in Cairo terms. */
function inCairo(date: Date | null | undefined): string | null {
  if (!date) return null;
  return DateTime.fromJSDate(date, { zone: 'Africa/Cairo' }).toFormat("yyyy-MM-dd'T'HH:mm");
}

// 2026-08-17 is a Monday; 2026-08-21 a Friday; 2026-08-23 a Sunday.

describe('isWithinBusinessHours', () => {
  it('is open during the working day', () => {
    expect(isWithinBusinessHours(config, at('2026-08-17T12:00'))).toBe(true);
  });

  it('is shut before opening and after closing', () => {
    expect(isWithinBusinessHours(config, at('2026-08-17T08:00'))).toBe(false);
    expect(isWithinBusinessHours(config, at('2026-08-17T19:00'))).toBe(false);
  });

  it('treats the closing minute as shut and the opening minute as open', () => {
    expect(isWithinBusinessHours(config, at('2026-08-17T17:00'))).toBe(false);
    expect(isWithinBusinessHours(config, at('2026-08-17T16:59'))).toBe(true);
    expect(isWithinBusinessHours(config, at('2026-08-17T09:00'))).toBe(true);
    expect(isWithinBusinessHours(config, at('2026-08-17T08:59'))).toBe(false);
  });

  it('is shut on Friday and Saturday', () => {
    expect(isWithinBusinessHours(config, at('2026-08-21T12:00'))).toBe(false);
    expect(isWithinBusinessHours(config, at('2026-08-22T12:00'))).toBe(false);
  });

  it('evaluates in the schedule timezone, not UTC', () => {
    // In August, Cairo is UTC+3. 09:30 Cairo is 06:30 UTC — a server comparing
    // raw UTC against "09:00" would call this closed, and would be wrong for
    // the first three hours of every working day.
    const morning = at('2026-08-17T09:30');
    expect(morning.toISOString()).toBe('2026-08-17T06:30:00.000Z');
    expect(isWithinBusinessHours(config, morning)).toBe(true);

    // And 17:30 Cairo is 14:30 UTC, which the same comparison would call open —
    // the direction that puts a live-chat widget in front of an empty office.
    const evening = at('2026-08-17T17:30');
    expect(evening.toISOString()).toBe('2026-08-17T14:30:00.000Z');
    expect(isWithinBusinessHours(config, evening)).toBe(false);
  });

  it('gets the offset right on the other side of the DST boundary', () => {
    // Same wall-clock hour in January, when Cairo is UTC+2. This is the case a
    // hard-coded offset gets wrong for half the year.
    const winter = at('2026-01-19T09:30');
    expect(winter.toISOString()).toBe('2026-01-19T07:30:00.000Z');
    expect(isWithinBusinessHours(config, winter)).toBe(true);
  });

  it('respects a holiday', () => {
    const withHoliday: HoursConfig = {
      ...config,
      holidays: [{ date: '2026-08-17', name: 'Test holiday' }],
    };
    expect(isWithinBusinessHours(withHoliday, at('2026-08-17T12:00'))).toBe(false);
  });

  it('handles a split day with a lunch break', () => {
    const split: HoursConfig = {
      ...config,
      schedule: {
        ...CAIRO,
        mon: [
          { start: '09:00', end: '13:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    };

    expect(isWithinBusinessHours(split, at('2026-08-17T11:00'))).toBe(true);
    expect(isWithinBusinessHours(split, at('2026-08-17T13:30'))).toBe(false);
    expect(isWithinBusinessHours(split, at('2026-08-17T16:00'))).toBe(true);
  });

  it('closes rather than opens on a malformed configuration', () => {
    // Each of these would put the widget into live-chat mode with nobody
    // watching if it defaulted the other way.
    expect(isWithinBusinessHours({ ...config, timezone: 'Not/AZone' }, new Date())).toBe(false);
    expect(
      isWithinBusinessHours(
        { ...config, schedule: { ...CAIRO, mon: [{ start: '25:00', end: '99:00' }] } },
        at('2026-08-17T12:00'),
      ),
    ).toBe(false);
    expect(
      isWithinBusinessHours(
        { ...config, schedule: { ...CAIRO, mon: [{ start: '17:00', end: '09:00' }] } },
        at('2026-08-17T12:00'),
      ),
    ).toBe(false);
  });
});

describe('nextOpeningAt', () => {
  it("returns today's opening when asked before it", () => {
    expect(inCairo(nextOpeningAt(config, at('2026-08-17T07:00')))).toBe('2026-08-17T09:00');
  });

  it('skips to the next day when asked mid-window', () => {
    // Not the window already in progress.
    expect(inCairo(nextOpeningAt(config, at('2026-08-17T12:00')))).toBe('2026-08-18T09:00');
  });

  it('skips the weekend', () => {
    // Thursday evening → Sunday, because Friday and Saturday are off.
    expect(inCairo(nextOpeningAt(config, at('2026-08-20T19:00')))).toBe('2026-08-23T09:00');
  });

  it('skips a holiday', () => {
    const withHoliday: HoursConfig = { ...config, holidays: [{ date: '2026-08-18' }] };
    expect(inCairo(nextOpeningAt(withHoliday, at('2026-08-17T19:00')))).toBe('2026-08-19T09:00');
  });

  it('returns null when nothing is scheduled in the lookahead', () => {
    const never: HoursConfig = {
      ...config,
      schedule: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    };
    expect(nextOpeningAt(never, at('2026-08-17T12:00'))).toBeNull();
  });
});
