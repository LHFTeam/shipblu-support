import { DateTime } from 'luxon';
import type { TimeRange, WeeklySchedule } from '@/db/schema/config';

/**
 * Business hours evaluation.
 *
 * Used by the chat widget to decide between "an agent is here" and "leave a
 * message", and later by the SLA clock, which is why it lives outside
 * `lib/widget`.
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
  if (!holidays?.length) return false;
  const iso = dt.toISODate();
  return holidays.some((holiday) => holiday.date === iso);
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
    if (isHoliday(day, config.holidays)) continue;

    const ranges = rangesFor(day, config.schedule)
      .map((range) => ({ start: parseMinutes(range.start), end: parseMinutes(range.end) }))
      .filter(
        (range): range is { start: number; end: number } =>
          range.start !== null && range.end !== null && range.end > range.start,
      )
      .sort((a, b) => a.start - b.start);

    for (const range of ranges) {
      const opensAt = day.plus({ minutes: range.start });
      // Strictly after `at`, so a call made mid-window returns the *next*
      // window rather than one already in progress.
      if (opensAt.toMillis() > start.toMillis()) return opensAt.toJSDate();
    }
  }

  return null;
}

/** Formatted for a customer, in the schedule's timezone and their language. */
export function formatOpening(at: Date, timezone: string, locale: string): string {
  return DateTime.fromJSDate(at, { zone: timezone })
    .setLocale(locale === 'ar' ? 'ar-EG' : 'en-GB')
    .toFormat("cccc 'at' HH:mm");
}
