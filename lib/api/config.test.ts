import { describe, expect, it } from 'vitest';
import type { WeeklySchedule } from '@/db/schema/config';
import type { HoursConfig } from '@/lib/hours';
import { emptyCatalog, groupHours } from '@/lib/hours/resolve';
import { cairo } from '@/lib/testing/time';
import { configFor, POLL_LIST_SECONDS, supportHoursAt } from './config';
import { Config, SupportHours } from './schemas';

/**
 * `support` on `GET /config`: the team's hours as the app is told them, asked
 * of `lib/hours` in the schedule's own zone at one instant. Every answer goes
 * through the published schema, so an instant without its `Z`, or a missing
 * field, fails here rather than in an app.
 *
 * The week is production's, read on 2026-11-13: Cairo, 10:00 to 18:00,
 * Saturday to Thursday, Friday off. 2026-11-13 is a Friday.
 */

const day = [{ start: '10:00', end: '18:00' }];
const PRODUCTION: WeeklySchedule = {
  sat: day,
  sun: day,
  mon: day,
  tue: day,
  wed: day,
  thu: day,
  fri: [],
};
const cairoWeek: HoursConfig = { schedule: PRODUCTION, timezone: 'Africa/Cairo' };
const SHUT: WeeklySchedule = { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [] };

const hoursAt = (hours: HoursConfig | null, at: Date) =>
  SupportHours.parse(supportHoursAt(hours, at));

describe('supportHoursAt', () => {
  it('is online in a working hour, with no opening to wait for', () => {
    expect(hoursAt(cairoWeek, cairo('2026-11-15T12:00'))).toEqual({
      online: true,
      opensAt: null,
      timezone: 'Africa/Cairo',
    });
  });

  it('is closed at the closing minute, and opens the next working morning, in UTC with its Z', () => {
    const answer = hoursAt(cairoWeek, cairo('2026-11-15T18:00'));
    expect(answer).toEqual({
      online: false,
      opensAt: cairo('2026-11-16T10:00').toISOString(),
      timezone: 'Africa/Cairo',
    });
    expect(answer.opensAt).toMatch(/Z$/);
  });

  it('skips the day off', () => {
    expect(hoursAt(cairoWeek, cairo('2026-11-19T19:00')).opensAt).toBe(
      cairo('2026-11-21T10:00').toISOString(),
    );
    // Asked on the Friday itself.
    expect(hoursAt(cairoWeek, cairo('2026-11-13T12:00'))).toMatchObject({
      online: false,
      opensAt: cairo('2026-11-14T10:00').toISOString(),
    });
  });

  it('is closed on a holiday, and opens the working day after it', () => {
    const withHoliday: HoursConfig = { ...cairoWeek, holidays: [{ date: '2026-11-16' }] };
    expect(hoursAt(withHoliday, cairo('2026-11-16T12:00'))).toEqual({
      online: false,
      opensAt: cairo('2026-11-17T10:00').toISOString(),
      timezone: 'Africa/Cairo',
    });
  });

  // Egypt's summer time ends at midnight on the last Thursday of October: the
  // Thursday evening is UTC+3 and the Saturday morning UTC+2. Written in UTC,
  // so a step of twenty-four hours across the change, or a reading in the
  // server's zone, cannot agree with it by building it the same way.
  it('opens at the right instant across the autumn change', () => {
    expect(hoursAt(cairoWeek, cairo('2026-10-29T20:00'))).toEqual({
      online: false,
      opensAt: '2026-10-31T08:00:00.000Z',
      timezone: 'Africa/Cairo',
    });
  });

  it('opens at the right instant across the spring change', () => {
    // Thursday 23 April 2026 is UTC+2; the clocks go forward at midnight, and
    // Saturday 25 April opens at 10:00 UTC+3.
    expect(hoursAt(cairoWeek, cairo('2026-04-23T20:00')).opensAt).toBe('2026-04-25T07:00:00.000Z');
  });

  it('is offline with nothing to draw when no hours are set', () => {
    expect(hoursAt(null, cairo('2026-11-15T12:00'))).toEqual({
      online: false,
      opensAt: null,
      timezone: null,
    });
  });

  it('treats a zone luxon cannot read as no hours, never handing it to a client', () => {
    expect(hoursAt({ ...cairoWeek, timezone: 'Mars/Olympus' }, cairo('2026-11-15T12:00'))).toEqual({
      online: false,
      opensAt: null,
      timezone: null,
    });
  });

  it('says the zone and no opening for a week with no open day', () => {
    expect(
      hoursAt({ schedule: SHUT, timezone: 'Africa/Cairo' }, cairo('2026-11-15T12:00')),
    ).toEqual({ online: false, opensAt: null, timezone: 'Africa/Cairo' });
  });

  // The widget's line looks fourteen days ahead; told "nothing" on a long
  // closure, the app would draw the team as having no hours at all.
  it('looks past a closure longer than a fortnight', () => {
    const everyDay: WeeklySchedule = { ...PRODUCTION, fri: day };
    // Twenty calendar days, 16 November to 5 December.
    const closed = Array.from({ length: 20 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 10, 16 + i)).toISOString().slice(0, 10),
    }));
    expect(closed.at(-1)!.date).toBe('2026-12-05');
    expect(
      hoursAt(
        { schedule: everyDay, timezone: 'Africa/Cairo', holidays: closed },
        cairo('2026-11-16T12:00'),
      ).opensAt,
    ).toBe(cairo('2026-12-06T10:00').toISOString());
  });

  it('reads a group’s own schedule over the default, and the default for any other group', () => {
    const catalog = emptyCatalog();
    catalog.schedules.set('default', cairoWeek);
    catalog.schedules.set('sales', { ...cairoWeek, schedule: { ...PRODUCTION, sat: [] } });
    catalog.defaultId = 'default';
    catalog.overrides.set('inbound-sales', 'sales');
    const saturday = cairo('2026-11-14T12:00');

    for (const group of [null, 'customer-care']) {
      expect(hoursAt(groupHours(catalog, group), saturday)).toMatchObject({ online: true });
    }
    expect(hoursAt(groupHours(catalog, 'inbound-sales'), saturday)).toEqual({
      online: false,
      opensAt: cairo('2026-11-15T10:00').toISOString(),
      timezone: 'Africa/Cairo',
    });
  });
});

describe('configFor', () => {
  it('carries the hours it is given and the list’s poll', () => {
    const support = supportHoursAt(cairoWeek, cairo('2026-11-15T12:00'));
    const config = Config.parse(
      configFor(
        {
          identityId: '0b7e9c2a-1f3d-4e5a-9b6c-7d8e9f0a1b2c',
          contactId: 'c',
          externalUserId: 'u_83412',
          tokenHash: 'h',
          platform: 'ios',
          appVersion: '5.4.1',
        },
        true,
        support,
      ),
    );
    expect(config.support).toEqual(support);
    expect(config.polling.listSeconds).toBe(POLL_LIST_SECONDS);
    expect(Object.keys(config).sort()).toEqual(['limits', 'polling', 'support', 'tickets', 'user']);
  });
});
