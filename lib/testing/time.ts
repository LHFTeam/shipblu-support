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
 * Eight test files each wrote that conversion out, and only one of them
 * checked that luxon had understood the string: an unreadable one becomes an
 * Invalid Date, every comparison against it is false, and a test asserting that
 * something is *not* due passes for the wrong reason.
 *
 * Luxon also answers two other strings without complaint, and each would have a
 * test checking a different instant from the one it names:
 *
 * - a wall-clock time the spring change skips (`2026-04-24T00:30` — clocks go
 *   from 00:00 to 01:00) comes back as the hour after it. Refused here.
 * - an explicit offset or `Z` is obeyed, so a hand-converted fixture could pass
 *   through a function named for Cairo. Refused here.
 *
 * A time the autumn change repeats (`2026-10-29T23:30` happens at +03:00 and
 * again at +02:00) is ambiguous rather than wrong, and resolves to the first,
 * still in summer time. A test that means the second adds an hour to it.
 *
 * Still on luxon, each for a reason: `forms/summary` builds the offset-carrying
 * `toISO()` string the parser stores, which is the thing under test; the DST case
 * in `reports/intervals` does arithmetic on `DateTime` values; and
 * `reports/agent-queries` compares calendar dates, not instants.
 *
 * Cairo by name, not `TEAM_TIME_ZONE`: these tests assert in Cairo, and should
 * keep doing so if the constant ever moves.
 */

const CAIRO = 'Africa/Cairo';
const FIELDS = "yyyy-MM-dd'T'HH:mm:ss.SSS";
const WITH_OFFSET = /T[\d:.,]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** `2026-09-03T09:30` on a Cairo wall clock, as the instant it names. */
export function cairo(iso: string): Date {
  if (WITH_OFFSET.test(iso)) {
    throw new Error(`not a Cairo wall-clock time, it names its own offset: ${iso}`);
  }
  const dt = DateTime.fromISO(iso, { zone: CAIRO });
  if (!dt.isValid) throw new Error(`not a Cairo wall-clock time: ${iso}`);
  // The same string read with no zone at all holds the fields as written; a
  // skipped time is the one case where Cairo's reading of them moved.
  const asWritten = DateTime.fromISO(iso, { zone: 'utc' });
  if (dt.toFormat(FIELDS) !== asWritten.toFormat(FIELDS)) {
    throw new Error(`not a Cairo wall-clock time, the clocks skip it: ${iso}`);
  }
  return dt.toJSDate();
}

/** The inverse, `yyyy-MM-ddTHH:mm` in Cairo, for asserting on a returned instant. */
export function inCairo(date: Date | null | undefined): string | null {
  if (!date) return null;
  return DateTime.fromJSDate(date, { zone: CAIRO }).toFormat("yyyy-MM-dd'T'HH:mm");
}
