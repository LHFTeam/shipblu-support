import { DateTime, IANAZone } from 'luxon';

/**
 * Which instants a name on a zone's clock means: a day, or a date and time
 * written with no offset.
 *
 * Each has an obvious luxon spelling that is wrong at a changeover, and wrong
 * differently depending on when it runs, so each is answered once, here, for
 * every reader: the rollups cut their days with `dayWindow`, and a scan bound
 * typed at `npm run job` is read through both (`lib/queue/payloads.ts`).
 */

/**
 * Where a day begins and ends in `zone`, end exclusive, or null for a day that
 * does not parse. Every rollup cuts its day here, so `metrics_daily`, the agent
 * rows and the subcategory rows, written for one day in one transaction, put an
 * instant on the same day.
 *
 * Both ends are a `startOf('day')`. The end is not the start plus a day: Cairo
 * springs forward at midnight, so a changeover day such as 24 April 2026 has no
 * 00:00 and opens at 01:00, and a day added to that is 01:00 on the 25th. The
 * subcategory rollup cut its own day that way, and the first hour of the 25th
 * counted on both days (`docs/PROJECT-STATE.md` §6.101). The start is a
 * `startOf('day')` too, because luxon can resolve a bare date an hour late in
 * a zone whose clocks jump across the date line, and that hour would then be
 * on no day.
 */
export function dayWindow(day: string, zone: string): { start: Date; end: Date } | null {
  const date = DateTime.fromISO(day, { zone });
  if (!date.isValid) return null;
  const start = date.startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}

// A calendar date and a time, and nothing after it. Luxon's `fromISO` takes
// more: a `Z`, an offset, a bracketed zone (`…+03:00[Africa/Cairo]`), a time
// with no date. Each of those it would resolve while reading the fields, and the
// result read again on this zone's clock is off by the offset it named or dated
// by UTC's today, so a list of the spellings to turn away is always one short.
// The hour runs 00-23, as a scan bound's does: luxon reads `T24:00` as the next
// midnight, a second spelling of it, which on the eve of a spring change this
// function would then call skipped though the date written was never touched.
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:[.,]\d+)?)?$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The instant a clock in `zone` showed `local`, a date and time written with no
 * offset (`2026-10-29T23:30`): `'skipped'` when no instant did, null when the
 * text is anything else (an offset, a zone, a time with no date, hour 24) or
 * the zone is not one. A caller holding such text reads it some other way.
 *
 * Usually one instant. In the hour an autumn change repeats there are two, and
 * this answers the first, still on summer time, whenever it runs:
 * `DateTime.fromISO(local, { zone })` picks between them by the offset the zone
 * has on the day it is asked, so the same text named one instant in summer and
 * the other in winter (§6.102). In the hour a spring change skips there is
 * none, and what that means is the caller's to decide: a bound typed at the
 * command line is refused, where luxon would move it on by the gap.
 *
 * The instants are worked out from the zone's offsets a day either side of the
 * written fields, which is every offset the clock could have shown them at
 * while no zone changes its offset twice within two days.
 */
export function wallClockInstant(local: string, zone: string): Date | 'skipped' | null {
  if (!WALL_CLOCK.test(local)) return null;
  const tz = IANAZone.create(zone);
  // The fields as written, on a clock that never changes, so nothing is
  // resolved yet.
  const written = DateTime.fromISO(local, { zone: 'utc' });
  if (!tz.isValid || !written.isValid) return null;
  const fields = written.toMillis();

  const offsetAt = (ms: number) => tz.offset(ms) * MINUTE;
  const [first] = [offsetAt(fields - DAY), offsetAt(fields + DAY)]
    .map((offset) => fields - offset)
    .filter((at) => offsetAt(at) === fields - at)
    .sort((a, b) => a - b);
  return first === undefined ? 'skipped' : new Date(first);
}
