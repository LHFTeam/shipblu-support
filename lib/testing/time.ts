import { DateTime } from 'luxon';

/**
 * Instants for tests, built from Cairo wall-clock time.
 *
 * Deliberately not hand-converted to UTC in the test. Egypt reinstated summer
 * time in 2023, so Cairo is UTC+2 in winter and UTC+3 in summer — writing the
 * offsets by hand is how a test ends up asserting the wrong thing and passing
 * against a bug. Letting the timezone database do it means these read as the
 * team's own hours.
 *
 * Six test files each wrote that conversion out, and only one of them checked
 * that luxon had understood the string: an unreadable one becomes an Invalid
 * Date, every comparison against it is false, and a test asserting that
 * something is *not* due passes for the wrong reason.
 *
 * Cairo by name, not `TEAM_TIME_ZONE`: these tests assert in Cairo, and should
 * keep doing so if the constant ever moves.
 */

const CAIRO = 'Africa/Cairo';

/** `2026-09-03T09:30` on a Cairo wall clock, as the instant it names. */
export function cairo(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: CAIRO });
  if (!dt.isValid) throw new Error(`not a Cairo wall-clock time: ${iso}`);
  return dt.toJSDate();
}

/** The inverse, `yyyy-MM-ddTHH:mm` in Cairo, for asserting on a returned instant. */
export function inCairo(date: Date | null | undefined): string | null {
  if (!date) return null;
  return DateTime.fromJSDate(date, { zone: CAIRO }).toFormat("yyyy-MM-dd'T'HH:mm");
}
