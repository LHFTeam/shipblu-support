import { DateTime } from 'luxon';
import type { TimeRange, WeeklySchedule } from '@/db/schema/config';

/**
 * Business hours evaluation.
 *
 * Used by the chat widget to decide between "an agent is here" and "leave a
 * message", and by the SLA clock, which is why it lives outside `lib/widget`.
 *
 * Everything is computed in the schedule's own timezone rather than the
 * server's. Render runs UTC and the team works Africa/Cairo, so any comparison
 * done in server time is wrong by two or three hours depending on the season —
 * and it fails in the least visible way possible, by being right for most of
 * the day.
 */

export type Holiday = { date: string; name?: string };

export type HoursConfig = {
  schedule: WeeklySchedule;
  timezone: string;
  holidays?: Holiday[];
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

/** Luxon weekdays run Monday=1…Sunday=7; the schedule is keyed by name. */
function dayKey(dt: DateTime): DayKey {
  return DAY_KEYS[dt.weekday % 7]!;
}

function parseMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // 24:00 is a legitimate way to write "end of day" and must not be rejected,
  // but 25:00 is a typo that would otherwise silently extend the working day.
  if (hours > 24 || minutes > 59) return null;
  if (hours === 24 && minutes !== 0) return null;

  return hours * 60 + minutes;
}

function isHoliday(dt: DateTime, holidays: Holiday[] | undefined): boolean {
  return findHoliday(dt, holidays) !== null;
}

function findHoliday(dt: DateTime, holidays: Holiday[] | undefined): Holiday | null {
  if (!holidays?.length) return null;
  const iso = dt.toISODate();
  return holidays.find((holiday) => holiday.date === iso) ?? null;
}

/**
 * The holiday falling on an instant's local date, or null.
 *
 * Separate from `isWithinBusinessHours` because a closed office and a closed
 * office *for Eid* are two different messages to send, and the name is half of
 * the second one. Returning the holiday rather than a boolean is what lets the
 * auto-responder interpolate it without re-scanning the list.
 *
 * Answers on its own terms: a holiday on a day the schedule was shut anyway is
 * still a holiday, and a holiday in the middle of a working day is one too —
 * `isWithinBusinessHours` already treats that day as closed.
 */
export function holidayOn(config: HoursConfig, at: Date = new Date()): Holiday | null {
  const local = DateTime.fromJSDate(at, { zone: config.timezone });
  if (!local.isValid) return null;

  return findHoliday(local, config.holidays);
}

/** Ranges for one day, ignoring holidays. */
function rangesFor(dt: DateTime, schedule: WeeklySchedule): TimeRange[] {
  return schedule[dayKey(dt)] ?? [];
}

export function isWithinBusinessHours(config: HoursConfig, at: Date = new Date()): boolean {
  const local = DateTime.fromJSDate(at, { zone: config.timezone });

  // An unknown IANA zone gives an invalid DateTime. Treating that as "open"
  // would put the widget into live-chat mode with nobody watching it, so a
  // misconfiguration closes rather than opens.
  if (!local.isValid) return false;

  if (isHoliday(local, config.holidays)) return false;

  const minutes = local.hour * 60 + local.minute;

  return rangesFor(local, config.schedule).some((range) => {
    const start = parseMinutes(range.start);
    const end = parseMinutes(range.end);
    if (start === null || end === null || end <= start) return false;
    // End-exclusive: at exactly 17:00 on a 09:00–17:00 day, the office is shut.
    return minutes >= start && minutes < end;
  });
}

/**
 * When the next working period begins, or null if none within `lookaheadDays`.
 *
 * Drives the widget's "we reply from 9am" line. Scanning forward day by day
 * rather than computing it arithmetically is what makes holidays and an empty
 * weekend fall out for free.
 */
export function nextOpeningAt(
  config: HoursConfig,
  at: Date = new Date(),
  lookaheadDays = 14,
): Date | null {
  const start = DateTime.fromJSDate(at, { zone: config.timezone });
  if (!start.isValid) return null;

  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const day = start.plus({ days: offset }).startOf('day');

    for (const interval of openIntervalsOn(day, config)) {
      // Strictly after `at`, so a call made mid-window returns the *next*
      // window rather than one already in progress.
      if (interval.start.toMillis() > start.toMillis()) return interval.start.toJSDate();
    }
  }

  return null;
}

/**
 * The envelope of one local day's schedule: first opening to last closing.
 *
 * The envelope rather than the individual periods, because its consumer is
 * punctuality — "was the agent here when the doors opened" — and a schedule
 * with a lunch break in the middle still has one start of day and one end of
 * it. Null on a holiday or a day the schedule is closed, which is what stops
 * the productivity report calling somebody late for a day nobody asked them to
 * work.
 *
 * Exported so reporting resolves a shift through the same code the SLA clock
 * resolves a due date through: the alternative is a second reading of the same
 * `WeeklySchedule` that agrees with this one until somebody adds a holiday.
 */
export function scheduledWindow(config: HoursConfig, at: Date): { start: Date; end: Date } | null {
  const day = DateTime.fromJSDate(at, { zone: config.timezone });
  if (!day.isValid) return null;

  const intervals = openIntervalsOn(day.startOf('day'), config);
  if (intervals.length === 0) return null;

  return {
    start: intervals[0]!.start.toJSDate(),
    end: intervals[intervals.length - 1]!.end.toJSDate(),
  };
}

/**
 * The open periods of one local day, in chronological order.
 *
 * Built as real instants rather than minute offsets so that everything above
 * can do plain interval arithmetic and get DST right for free: on a day when
 * the clocks move, 09:00–17:00 is not eight hours, and an SLA due date computed
 * by adding minutes to midnight would be an hour out for that day.
 */
function openIntervalsOn(day: DateTime, config: HoursConfig): { start: DateTime; end: DateTime }[] {
  if (isHoliday(day, config.holidays)) return [];

  return rangesFor(day, config.schedule)
    .map((range) => ({ start: parseMinutes(range.start), end: parseMinutes(range.end) }))
    .filter(
      (range): range is { start: number; end: number } =>
        range.start !== null && range.end !== null && range.end > range.start,
    )
    .sort((a, b) => a.start - b.start)
    .map((range) => ({ start: atMinute(day, range.start), end: atMinute(day, range.end) }));
}

/** Wall-clock time on a given day. 24:00 is midnight at the end of it. */
function atMinute(day: DateTime, minutes: number): DateTime {
  const midnight = day.startOf('day');
  if (minutes >= 24 * 60) return midnight.plus({ days: 1 }).startOf('day');

  return midnight.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });
}

/** A year of lookahead: far enough for any real SLA, bounded enough to end. */
const MAX_SCAN_DAYS = 366;

/**
 * `from` plus `minutes` of *open* time — the SLA due date.
 *
 * This is what makes "resolve within 4 hours" mean four working hours rather
 * than four wall-clock hours. A ticket arriving at 16:00 on a Thursday with a
 * 4-hour target is due at 12:00 on Sunday, not overnight on a day the office is
 * shut and nobody could have answered it.
 *
 * Returns null when the schedule has no open time at all within the scan
 * window, which means a policy pointing at an empty schedule yields no due date
 * rather than one a year out. Round-the-clock policies do not come through here
 * at all — they carry no business hours and add wall-clock time directly.
 */
export function addBusinessMinutes(config: HoursConfig, from: Date, minutes: number): Date | null {
  const start = DateTime.fromJSDate(from, { zone: config.timezone });
  if (!start.isValid) return null;

  let remaining = Math.max(0, minutes);

  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset += 1) {
    const day = start.plus({ days: offset }).startOf('day');

    for (const interval of openIntervalsOn(day, config)) {
      // Clip to `from`: the working time before the ticket arrived is not time
      // anyone owed the customer.
      const cursor = interval.start.toMillis() > start.toMillis() ? interval.start : start;
      if (cursor.toMillis() >= interval.end.toMillis()) continue;

      // A zero target resolves to the next instant the office is open, which is
      // `from` itself whenever the ticket arrives during working hours.
      if (remaining === 0) return cursor.toJSDate();

      const available = interval.end.diff(cursor, 'minutes').minutes;
      if (remaining <= available) return cursor.plus({ minutes: remaining }).toJSDate();

      remaining -= available;
    }
  }

  return null;
}

/**
 * Open minutes between two instants.
 *
 * The inverse of `addBusinessMinutes`, and the reason reporting can say a
 * ticket was answered in 20 minutes when it arrived at 16:50 and was answered
 * at 09:10 the next morning. Overnight silence is not response time.
 */
export function businessMinutesBetween(config: HoursConfig, from: Date, to: Date): number {
  const start = DateTime.fromJSDate(from, { zone: config.timezone });
  const end = DateTime.fromJSDate(to, { zone: config.timezone });
  if (!start.isValid || !end.isValid) return 0;
  if (end.toMillis() <= start.toMillis()) return 0;

  let total = 0;

  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset += 1) {
    const day = start.plus({ days: offset }).startOf('day');
    if (day.toMillis() > end.toMillis()) break;

    for (const interval of openIntervalsOn(day, config)) {
      const overlapStart = interval.start.toMillis() > start.toMillis() ? interval.start : start;
      const overlapEnd = interval.end.toMillis() < end.toMillis() ? interval.end : end;
      if (overlapEnd.toMillis() <= overlapStart.toMillis()) continue;

      total += overlapEnd.diff(overlapStart, 'minutes').minutes;
    }
  }

  return total;
}

/**
 * Formatted for a customer, in the schedule's timezone and their language.
 *
 * The connector is translated along with the day name. Formatting Arabic with
 * an English "at" is the kind of half-localised string that reads worse than
 * plain English does, and this is the first line an Arabic-speaking customer
 * gets from us out of hours.
 *
 * `-u-nu-latn` keeps the clock in 0–9 rather than letting ar-EG render it in
 * Arabic-Indic digits. Egyptian screens — prices, phone numbers, the tracking
 * numbers in these very tickets — are written in Latin digits, so ٠٩:٠٠ next to
 * a shipment number in the same message reads as two different alphabets for
 * the same idea.
 */
export function formatOpening(at: Date, timezone: string, locale: string): string {
  const arabic = locale === 'ar';

  return DateTime.fromJSDate(at, { zone: timezone })
    .setLocale(arabic ? 'ar-EG-u-nu-latn' : 'en-GB')
    .toFormat(arabic ? "cccc 'الساعة' HH:mm" : "cccc 'at' HH:mm");
}
