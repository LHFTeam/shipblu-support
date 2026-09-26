import { describe, expect, it } from 'vitest';
import { cairo as at, inCairo } from '@/lib/testing/time';
import type { WeeklySchedule } from '@/db/schema/config';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  holidayName,
  holidayOn,
  isWithinBusinessHours,
  nextOpeningAt,
  type HoursConfig,
} from './index';

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
      holidays: [{ date: '2026-08-17', nameEn: 'Test holiday' }],
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

describe('addBusinessMinutes', () => {
  it('adds within a single working day', () => {
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T10:00'), 120))).toBe(
      '2026-08-17T12:00',
    );
  });

  it('carries the remainder into the next working day', () => {
    // 16:00 Monday + 4 working hours: one hour left on Monday, three on Tuesday.
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T16:00'), 240))).toBe(
      '2026-08-18T12:00',
    );
  });

  it('does not spend the weekend', () => {
    // The case that makes this worth having: 16:00 Thursday + 4 hours is noon
    // on Sunday, not the small hours of Friday when nobody could have replied.
    expect(inCairo(addBusinessMinutes(config, at('2026-08-20T16:00'), 240))).toBe(
      '2026-08-23T12:00',
    );
  });

  it('starts the clock at opening when the ticket arrives out of hours', () => {
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T03:00'), 60))).toBe(
      '2026-08-17T10:00',
    );
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T22:00'), 60))).toBe(
      '2026-08-18T10:00',
    );
  });

  it('skips a holiday', () => {
    const withHoliday: HoursConfig = { ...config, holidays: [{ date: '2026-08-18' }] };
    expect(inCairo(addBusinessMinutes(withHoliday, at('2026-08-17T16:00'), 240))).toBe(
      '2026-08-19T12:00',
    );
  });

  it('crosses a lunch break without counting it', () => {
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
    // 12:00 + 2 working hours: one hour to 13:00, the rest from 14:00.
    expect(inCairo(addBusinessMinutes(split, at('2026-08-17T12:00'), 120))).toBe(
      '2026-08-17T15:00',
    );
  });

  it('resolves a zero target to the next open instant', () => {
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T10:00'), 0))).toBe('2026-08-17T10:00');
    expect(inCairo(addBusinessMinutes(config, at('2026-08-17T03:00'), 0))).toBe('2026-08-17T09:00');
  });

  it('returns null rather than a date a year out when nothing is scheduled', () => {
    const never: HoursConfig = {
      ...config,
      schedule: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    };
    expect(addBusinessMinutes(never, at('2026-08-17T12:00'), 60)).toBeNull();
    expect(addBusinessMinutes({ ...config, timezone: 'Not/AZone' }, new Date(), 60)).toBeNull();
  });
});

describe('businessMinutesBetween', () => {
  it('counts only open time', () => {
    expect(businessMinutesBetween(config, at('2026-08-17T10:00'), at('2026-08-17T12:30'))).toBe(
      150,
    );
  });

  it('ignores the overnight gap', () => {
    // Answered at 09:10 the next morning after arriving at 16:50: twenty
    // minutes of response time, not seventeen hours.
    expect(businessMinutesBetween(config, at('2026-08-17T16:50'), at('2026-08-18T09:10'))).toBe(20);
  });

  it('ignores the weekend and holidays', () => {
    expect(businessMinutesBetween(config, at('2026-08-20T16:00'), at('2026-08-23T10:00'))).toBe(
      120,
    );

    const withHoliday: HoursConfig = { ...config, holidays: [{ date: '2026-08-18' }] };
    expect(
      businessMinutesBetween(withHoliday, at('2026-08-17T16:00'), at('2026-08-19T10:00')),
    ).toBe(120);
  });

  it('is zero for a backwards or empty range', () => {
    expect(businessMinutesBetween(config, at('2026-08-17T12:00'), at('2026-08-17T12:00'))).toBe(0);
    expect(businessMinutesBetween(config, at('2026-08-17T12:00'), at('2026-08-17T10:00'))).toBe(0);
    // Entirely outside working hours.
    expect(businessMinutesBetween(config, at('2026-08-21T10:00'), at('2026-08-21T16:00'))).toBe(0);
  });

  it('round-trips with addBusinessMinutes', () => {
    const from = at('2026-08-20T16:00');
    const due = addBusinessMinutes(config, from, 240)!;
    expect(businessMinutesBetween(config, from, due)).toBe(240);
  });
});

describe('holidayName', () => {
  const eid = { date: '2026-03-22', nameAr: 'عيد الفطر', nameEn: 'Eid al-Fitr' };

  it('gives the name in the language asked for', () => {
    expect(holidayName(eid, 'ar')).toBe('عيد الفطر');
    expect(holidayName(eid, 'en')).toBe('Eid al-Fitr');
  });

  // A calendar filled in by an Arabic-speaking team is a complete calendar. The
  // alternative is an English acknowledgement with a hole where the day's name
  // should be.
  it('covers a missing name with the other language', () => {
    expect(holidayName({ date: '2026-03-22', nameAr: 'عيد الفطر' }, 'en')).toBe('عيد الفطر');
    expect(holidayName({ date: '2026-03-22', nameEn: 'Eid al-Fitr' }, 'ar')).toBe('Eid al-Fitr');
  });

  // Null rather than '' so `substitute` can tell "no name" from "a name that is
  // empty", and collapse the space the placeholder sat in.
  it('is null for a holiday with no name, and for no holiday at all', () => {
    expect(holidayName({ date: '2026-03-22' }, 'en')).toBeNull();
    expect(holidayName({ date: '2026-03-22', nameAr: '  ' }, 'ar')).toBeNull();
    expect(holidayName(null, 'en')).toBeNull();
  });

  it('reads the name off the calendar for the day an instant falls on', () => {
    const config: HoursConfig = { timezone: 'Africa/Cairo', schedule: CAIRO, holidays: [eid] };

    // 00:30 Cairo on the holiday is 22:30 UTC the day before: the date that
    // decides this is the local one, or a holiday starts two hours late.
    const justAfterMidnight = at('2026-03-22T00:30');

    expect(holidayName(holidayOn(config, justAfterMidnight), 'ar')).toBe('عيد الفطر');
  });
});
