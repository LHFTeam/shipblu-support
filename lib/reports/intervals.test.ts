import { describe, expect, it } from 'vitest';
import { cairo } from '@/lib/testing/time';
import { DateTime } from 'luxon';
import {
  clampSpans,
  firstStart,
  lastEnd,
  longestSeconds,
  mergeSpans,
  subtractSpans,
  toSpan,
  totalSeconds,
  type Span,
} from './intervals';

/** Wall-clock Cairo to an instant, so fixtures read as the shift they describe. */
function at(time: string, day = '2026-08-20'): Date {
  return cairo(`${day}T${time}`);
}

function span(from: string, to: string, day?: string): Span {
  return { start: at(from, day).getTime(), end: at(to, day).getTime() };
}

const MINUTE = 60_000;

describe('toSpan', () => {
  it('ends a closed interval at its sign-off', () => {
    const result = toSpan({
      startedAt: at('09:00'),
      lastBeatAt: at('16:59'),
      endedAt: at('17:00'),
    });
    expect(result.end).toBe(at('17:00').getTime());
  });

  it('ends a stream that died at its last beat, not at its absent sign-off', () => {
    // The failure this guards: an instance killed mid-stream never runs its
    // abort handler, so `endedAt` stays null for good. Treating that as "still
    // open" would credit the agent for every hour since.
    const result = toSpan({ startedAt: at('09:00'), lastBeatAt: at('11:30'), endedAt: null });
    expect(result.end).toBe(at('11:30').getTime());
  });

  it('clamps a row whose end precedes its start instead of going negative', () => {
    const result = toSpan({ startedAt: at('17:00'), lastBeatAt: at('09:00'), endedAt: null });
    expect(result.end).toBe(result.start);
    expect(totalSeconds([result])).toBe(0);
  });
});

describe('mergeSpans', () => {
  it('counts overlapping spans once', () => {
    // Two instances racing leave two open rows for one agent. Summed, that is a
    // sixteen-hour day; merged, it is the eight hours that actually happened.
    const merged = mergeSpans([span('09:00', '17:00'), span('09:00', '17:00')]);
    expect(merged).toHaveLength(1);
    expect(totalSeconds(merged)).toBe(8 * 3600);
  });

  it('does not let a short span swallowed by a long one shorten it', () => {
    const merged = mergeSpans([span('09:00', '17:00'), span('11:00', '11:30')]);
    expect(totalSeconds(merged)).toBe(8 * 3600);
  });

  it('stitches the reconnect flapping back into one shift', () => {
    // Closing one of two tabs marks the agent offline and the survivor's next
    // keepalive puts them back. Unstitched this reads as three sessions.
    const merged = mergeSpans(
      [span('09:00', '11:00'), span('11:00', '13:00'), span('13:01', '17:00')],
      2 * MINUTE,
    );

    expect(merged).toHaveLength(1);
    expect(longestSeconds(merged)).toBe(8 * 3600);
  });

  it('keeps a real break apart from a stitch', () => {
    // An hour's lunch is not a dropped connection, and must not be paid for.
    const merged = mergeSpans([span('09:00', '12:00'), span('13:00', '17:00')], 2 * MINUTE);

    expect(merged).toHaveLength(2);
    expect(totalSeconds(merged)).toBe(7 * 3600);
  });

  it('merges out of order input', () => {
    const merged = mergeSpans([span('13:00', '17:00'), span('09:00', '13:00')], 2 * MINUTE);
    expect(merged).toHaveLength(1);
  });

  it('drops zero-length spans', () => {
    expect(mergeSpans([span('09:00', '09:00')])).toEqual([]);
  });

  it('returns nothing for nothing', () => {
    expect(mergeSpans([])).toEqual([]);
  });
});

describe('clampSpans', () => {
  const dayStart = at('00:00', '2026-08-20').getTime();
  const dayEnd = at('00:00', '2026-08-21').getTime();

  it('splits a night shift across the two days it belongs to', () => {
    const overnight = [span('22:00', '06:00').start, at('06:00', '2026-08-21').getTime()];
    const shift: Span = { start: overnight[0]!, end: overnight[1]! };

    const monday = clampSpans([shift], dayStart, dayEnd);
    const tuesday = clampSpans([shift], dayEnd, at('00:00', '2026-08-22').getTime());

    expect(totalSeconds(monday)).toBe(2 * 3600);
    expect(totalSeconds(tuesday)).toBe(6 * 3600);
    // The halves must add up to the whole, or the days do not sum to the range.
    expect(totalSeconds(monday) + totalSeconds(tuesday)).toBe(8 * 3600);
  });

  it('drops a span entirely outside the window', () => {
    expect(clampSpans([span('09:00', '17:00', '2026-08-19')], dayStart, dayEnd)).toEqual([]);
  });

  it('measures a Cairo day across the DST boundary in real elapsed time', () => {
    // Cairo observes DST again. A day that gains or loses an hour must be
    // measured by the timezone database, never by assuming 24 hours — the trap
    // PROJECT-STATE records having been bitten by before.
    const zone = 'Africa/Cairo';
    const start = DateTime.fromISO('2026-10-29T00:00', { zone });
    const next = start.plus({ days: 1 }).startOf('day');
    const elapsedHours = next.diff(start, 'hours').hours;

    const whole: Span = { start: start.toMillis(), end: next.toMillis() };
    expect(totalSeconds(clampSpans([whole], whole.start, whole.end))).toBe(
      Math.round(elapsedHours * 3600),
    );
  });
});

describe('firstStart and lastEnd', () => {
  it('report the edges of the day, not of the first row', () => {
    const spans = [span('13:00', '17:00'), span('09:00', '12:00')];
    expect(firstStart(spans)).toEqual(at('09:00'));
    expect(lastEnd(spans)).toEqual(at('17:00'));
  });

  it('are null for an agent who never appeared', () => {
    expect(firstStart([])).toBeNull();
    expect(lastEnd([])).toBeNull();
  });
});

describe('subtractSpans', () => {
  it('returns the original when there is nothing to remove', () => {
    expect(subtractSpans([span('09:00', '17:00')], [])).toEqual([span('09:00', '17:00')]);
  });

  it('splits a span around a removal inside it', () => {
    // The case the accepting total needs: an agent parked mid-shift and back
    // ten minutes later is two stretches of available time, not one.
    expect(subtractSpans([span('09:00', '17:00')], [span('12:00', '12:10')])).toEqual([
      span('09:00', '12:00'),
      span('12:10', '17:00'),
    ]);
  });

  it('trims an overlap at either end', () => {
    expect(subtractSpans([span('09:00', '17:00')], [span('08:00', '09:30')])).toEqual([
      span('09:30', '17:00'),
    ]);
    expect(subtractSpans([span('09:00', '17:00')], [span('16:30', '18:00')])).toEqual([
      span('09:00', '16:30'),
    ]);
  });

  it('drops a span that is removed entirely', () => {
    expect(subtractSpans([span('09:00', '10:00')], [span('08:00', '11:00')])).toEqual([]);
  });

  it('ignores removals that do not touch anything', () => {
    expect(subtractSpans([span('09:00', '10:00')], [span('14:00', '15:00')])).toEqual([
      span('09:00', '10:00'),
    ]);
  });

  it('handles several removals from several spans', () => {
    expect(
      subtractSpans(
        [span('09:00', '12:00'), span('13:00', '17:00')],
        [span('10:00', '10:30'), span('11:00', '13:30'), span('16:00', '16:15')],
      ),
    ).toEqual([
      span('09:00', '10:00'),
      span('10:30', '11:00'),
      span('13:30', '16:00'),
      span('16:15', '17:00'),
    ]);
  });

  it('is the difference between welding a park and measuring it', () => {
    // The regression this exists for, in the shape the rollup meets it: two
    // accepting stretches a minute apart because the idle timer parked somebody
    // at 09:10 and they came back at 09:11. Stitching alone reports the minute
    // as available; subtracting the not-accepting interval does not.
    const stitched = mergeSpans([span('08:00', '09:10'), span('09:11', '17:00')], 2 * 60_000);
    expect(totalSeconds(stitched)).toBe(9 * 3600);

    expect(totalSeconds(subtractSpans(stitched, [span('09:10', '09:11')]))).toBe(9 * 3600 - 60);
  });
});
