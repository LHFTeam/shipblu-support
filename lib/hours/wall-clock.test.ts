import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cairo } from '@/lib/testing/time';
import { dayWindow, wallClockInstant } from './wall-clock';

/**
 * Where every rollup cuts its day. A day that does not end where the next one
 * begins counts an hour twice or not at all, and nothing in the stored rows
 * shows which: the subcategory rollup counted the first hour of 25 April 2026
 * on the 24th as well, because Cairo springs forward at the midnight that
 * opens the 24th and a day added to its 01:00 start ran an hour into the 25th
 * (`docs/PROJECT-STATE.md` §6.101).
 */
describe('dayWindow', () => {
  const CAIRO = 'Africa/Cairo';

  it('opens the day Cairo springs forward at 01:00 and ends it at the next midnight', () => {
    expect(dayWindow('2026-04-24', CAIRO)).toEqual({
      start: cairo('2026-04-24T01:00'),
      end: cairo('2026-04-25T00:00'),
    });
  });

  it('holds all 25 hours of the day the clocks go back', () => {
    const window = dayWindow('2026-10-29', CAIRO)!;
    expect(window).toEqual({ start: cairo('2026-10-29T00:00'), end: cairo('2026-10-30T00:00') });
    expect(window.end.getTime() - window.start.getTime()).toBe(25 * 3_600_000);
  });

  it('ends every Cairo day where the next begins, from DST coming back to 2027', () => {
    const seams: string[] = [];
    for (
      let day = DateTime.fromISO('2023-01-01', { zone: 'utc' });
      day.year < 2028;
      day = day.plus({ days: 1 })
    ) {
      const end = dayWindow(day.toISODate()!, CAIRO)!.end;
      const next = dayWindow(day.plus({ days: 1 }).toISODate()!, CAIRO)!.start;
      if (end.getTime() !== next.getTime()) seams.push(day.toISODate()!);
    }
    expect(seams).toEqual([]);
  });

  it('leaves no hour between two days where luxon reads a bare date an hour late', () => {
    // Samoa sprang forward on 24 September 2011 and crossed the date line that
    // December. Luxon resolves a wall-clock time from an offset it guesses for
    // the zone once and caches, and any guess since then (+13 or +14) is far
    // from 2011's, so a bare 25 September lands at 01:00 rather than at its
    // midnight; only the start's own `startOf('day')` puts it back.
    const zone = 'Pacific/Apia';
    expect(dayWindow('2011-09-25', zone)!.start).toEqual(dayWindow('2011-09-24', zone)!.end);
  });

  it('answers null for a day that does not parse', () => {
    expect(dayWindow('not-a-date', CAIRO)).toBeNull();
  });
});

/**
 * Every answer below is written in UTC rather than built with `cairo()`, which
 * reads its text through this function and so could only agree with it. And
 * each case runs on a host in UTC and in Cairo, because nothing here should
 * read the host's zone, and these are the cases that would say so: a scan
 * bound's tests switch hosts too, but most of their answers come from
 * `cairo()`, which would move with this function, and those that still failed
 * would point at the bound.
 */
describe.each([
  ['UTC', '2026-10-01T00:00:00.000Z'],
  ['Africa/Cairo', '2026-09-30T21:00:00.000Z'],
])('wallClockInstant, on a host in %s', (host, hostMidnight) => {
  const CAIRO = 'Africa/Cairo';
  const hostZone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = host;
  });
  afterEach(() => {
    vi.useRealTimers();
    // Assigning undefined would set the zone to the text "undefined".
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  });

  // The host's zone did change, or nothing below tests the host.
  it('is on a host that reads a time with no offset on its own clock', () => {
    expect(new Date('2026-10-01T00:00').toISOString()).toBe(hostMidnight);
  });

  it('reads a date and time on the zone clock, in summer and in winter', () => {
    expect(wallClockInstant('2026-08-15T14:30', CAIRO)).toEqual(new Date('2026-08-15T11:30:00Z'));
    expect(wallClockInstant('2026-01-15T14:30:15.250', CAIRO)).toEqual(
      new Date('2026-01-15T12:30:15.250Z'),
    );
  });

  it('answers the first instance of the hour the autumn change repeats, whenever it runs', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const now of ['2026-07-15T12:00:00Z', '2026-11-15T12:00:00Z']) {
      vi.setSystemTime(new Date(now));
      expect(wallClockInstant('2026-10-29T23:30', CAIRO)).toEqual(new Date('2026-10-29T20:30:00Z'));
      expect(wallClockInstant('2026-10-29T23:00', CAIRO)).toEqual(new Date('2026-10-29T20:00:00Z'));
    }
    // Luxon itself answers the second in winter, so the loop above did reach
    // the case it guards against.
    expect(DateTime.fromISO('2026-10-29T23:30', { zone: CAIRO }).offset).toBe(120);
  });

  it('says a time the spring change skipped was never shown, rather than moving it', () => {
    expect(wallClockInstant('2026-04-24T00:00', CAIRO)).toBe('skipped');
    expect(wallClockInstant('2026-04-24T00:59:59', CAIRO)).toBe('skipped');
    expect(wallClockInstant('2026-04-24T01:00', CAIRO)).toEqual(new Date('2026-04-23T22:00:00Z'));
    expect(wallClockInstant('2026-04-23T23:59', CAIRO)).toEqual(new Date('2026-04-23T21:59:00Z'));
  });

  // The zone is the caller's; nothing in the arithmetic is Cairo's hour.
  it('answers for another zone and another size of change', () => {
    // New York repeats 01:00-02:00 on 1 November 2026, first at -04:00.
    expect(wallClockInstant('2026-11-01T01:30', 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00Z'),
    );
    // Lord Howe Island moves its clocks half an hour: 02:00 to 02:30 on
    // 4 October 2026, and back from 02:00 to 01:30 on 5 April 2026.
    expect(wallClockInstant('2026-10-04T02:15', 'Australia/Lord_Howe')).toBe('skipped');
    expect(wallClockInstant('2026-04-05T01:45', 'Australia/Lord_Howe')).toEqual(
      new Date('2026-04-04T14:45:00Z'),
    );
  });

  it('answers null for text that is not a wall-clock time, or a zone that is not one', () => {
    expect(wallClockInstant('2026-08-15T14:30+03:00', CAIRO)).toBeNull();
    expect(wallClockInstant('2026-08-15T14:30Z', CAIRO)).toBeNull();
    // Each read by luxon with the zone it names and then, as a wall clock, off
    // by that offset again; and a time with no date dated by UTC's today.
    expect(wallClockInstant('2026-08-15T14:30+03:00[Africa/Cairo]', CAIRO)).toBeNull();
    expect(wallClockInstant('2026-08-15T14:30[Asia/Tokyo]', CAIRO)).toBeNull();
    expect(wallClockInstant('14:30', CAIRO)).toBeNull();
    expect(wallClockInstant('14:30Z', CAIRO)).toBeNull();
    expect(wallClockInstant('2026-02-30T09:00', CAIRO)).toBeNull();
    expect(wallClockInstant('half past nine', CAIRO)).toBeNull();
    expect(wallClockInstant('2026-08-15T14:30', 'Africa/Atlantis')).toBeNull();
  });
});
