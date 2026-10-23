import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import {
  adherence,
  focusMeasured,
  formatClock,
  formatDrift,
  formatHours,
  handlingSeconds,
  minutesEarlyOff,
  minutesLate,
  occupancy,
  reopenRate,
  resolvedPerHour,
} from './agent-queries';
import { rangeIn } from './rollup';
import { cairo } from '@/lib/testing/time';

const CAIRO = 'Africa/Cairo';

function at(time: string, day = '2026-08-20'): Date {
  return cairo(`${day}T${time}`);
}

describe('occupancy', () => {
  it('is focused time over time at the desk', () => {
    expect(occupancy({ focusSeconds: 6 * 3600, onlineSeconds: 8 * 3600 })).toBe(75);
  });

  it('is null rather than zero for an agent who was never online', () => {
    // Zero would render as "0% occupied", which reads as an agent who sat doing
    // nothing rather than one who was not there.
    expect(occupancy({ focusSeconds: 0, onlineSeconds: 0 })).toBeNull();
  });
});

describe('adherence', () => {
  it('measures covered shift against scheduled shift', () => {
    expect(adherence({ onlineWithinHoursSeconds: 7 * 3600, scheduledSeconds: 8 * 3600 })).toBe(88);
  });

  it('is null on a day with no schedule, not 0%', () => {
    // A closed day or a holiday. Calling that 0% adherence would punish an agent
    // for a day nobody asked them to work.
    expect(adherence({ onlineWithinHoursSeconds: 0, scheduledSeconds: 0 })).toBeNull();
  });
});

describe('minutesLate', () => {
  it('is positive when they arrived after the doors opened', () => {
    expect(minutesLate({ firstOnlineAt: at('09:12'), scheduledStartAt: at('09:00') })).toBe(12);
  });

  it('is negative when they were early', () => {
    expect(minutesLate({ firstOnlineAt: at('08:45'), scheduledStartAt: at('09:00') })).toBe(-15);
  });

  it('is null on a day with no schedule', () => {
    expect(minutesLate({ firstOnlineAt: at('09:12'), scheduledStartAt: null })).toBeNull();
  });

  it('is null when the agent never appeared', () => {
    // Absence and lateness are different findings; flattening one into the
    // other hides both.
    expect(minutesLate({ firstOnlineAt: null, scheduledStartAt: at('09:00') })).toBeNull();
  });

  it('is right across the Cairo DST boundary', () => {
    // Both instants are built from wall clock and converted by the timezone
    // database, so the arithmetic is on real elapsed time either side.
    const day = '2026-10-29';
    expect(
      minutesLate({ firstOnlineAt: at('09:20', day), scheduledStartAt: at('09:00', day) }),
    ).toBe(20);
  });
});

describe('minutesEarlyOff', () => {
  it('is positive when they left before closing', () => {
    expect(minutesEarlyOff({ lastOnlineAt: at('16:30'), scheduledEndAt: at('17:00') })).toBe(30);
  });

  it('is negative when they stayed late', () => {
    expect(minutesEarlyOff({ lastOnlineAt: at('17:45'), scheduledEndAt: at('17:00') })).toBe(-45);
  });
});

describe('handlingSeconds', () => {
  it('divides focused time by the conversations it was spread across', () => {
    expect(handlingSeconds({ focusSeconds: 3600, conversationsFocused: 12 })).toBe(300);
  });

  it('is null when nothing was worked', () => {
    expect(handlingSeconds({ focusSeconds: 0, conversationsFocused: 0 })).toBeNull();
  });
});

describe('reopenRate', () => {
  it('is the share of their own resolutions that came back', () => {
    expect(reopenRate({ reopenedAfterResolveCount: 3, resolutionsMade: 20 })).toBe(15);
  });

  it('is null rather than zero when they resolved nothing themselves', () => {
    expect(reopenRate({ reopenedAfterResolveCount: 0, resolutionsMade: 0 })).toBeNull();
  });

  it('divides by resolutions they made, not by tickets resolved under them', () => {
    // The two count different populations. An agent who personally resolved
    // four tickets and had three come back is at 75% — dividing by a larger
    // "resolved while assigned to them" figure would quietly flatter them, and
    // dividing by a smaller one could print over 100%.
    expect(reopenRate({ reopenedAfterResolveCount: 3, resolutionsMade: 4 })).toBe(75);
  });
});

describe('resolvedPerHour', () => {
  it('measures throughput against time at the desk', () => {
    expect(resolvedPerHour({ resolutionsMade: 16, onlineSeconds: 8 * 3600 })).toBe(2);
  });

  it('refuses to extrapolate from a few minutes online', () => {
    // Five minutes and one ticket is twelve an hour, which is not a rate — it
    // is a rounding error with a decimal point.
    expect(resolvedPerHour({ resolutionsMade: 1, onlineSeconds: 300 })).toBeNull();
  });
});

describe('focusMeasured', () => {
  it('is false when work happened but the beat reported nothing', () => {
    // A blocked beat must be visible as "not measured", never rendered as an
    // agent who spent no time on the eleven tickets they touched.
    expect(focusMeasured({ focusSeconds: 0, touchedCount: 11 })).toBe(false);
  });

  it('is true for a day with no work to measure', () => {
    expect(focusMeasured({ focusSeconds: 0, touchedCount: 0 })).toBe(true);
  });

  it('is true once the beat reports anything', () => {
    expect(focusMeasured({ focusSeconds: 60, touchedCount: 11 })).toBe(true);
  });
});

describe('rangeIn', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * How many days `to` is after `from`, counted on the dates, read in UTC as
   * `windowDays` and `planDays` read them (`docs/PROJECT-STATE.md` §6.101).
   * Read with no zone, each would be its midnight in the host's zone, and on a
   * machine set to Cairo the day the clocks spring forward has none: it opens
   * at 01:00, so a week starting on it measured 5.958 days. CI runs in UTC,
   * where every date has its midnight, so only a machine in Cairo could see it.
   */
  function daysBetween(from: string, to: string): number {
    const date = (day: string) => DateTime.fromISO(day, { zone: 'utc' });
    return date(to).diff(date(from), 'days').days;
  }

  it('covers exactly the days asked for, inclusive of today', () => {
    const { from, to } = rangeIn(CAIRO, 7);
    expect(daysBetween(from, to)).toBe(6);
  });

  it('keeps the first day of a week that opens on the day Cairo springs forward', () => {
    // The case above, frozen on 6 May 2027, so that it meets the day Cairo
    // springs forward (Friday 30 April, 00:00 to 01:00) on every run rather
    // than once a year. A week counted back in hours rather than dates would
    // open on the 29th.
    vi.useFakeTimers();
    vi.setSystemTime(cairo('2027-05-06T12:00'));

    const { from, to } = rangeIn(CAIRO, 7);
    expect({ from, to }).toEqual({ from: '2027-04-30', to: '2027-05-06' });
    expect(daysBetween(from, to)).toBe(6);
  });

  it('bounds the window in the team zone, not UTC', () => {
    // At 01:00 Cairo the UTC date is still yesterday. Bucketing by UTC would
    // shift the whole window and quietly drop an evening shift off the end.
    const { to } = rangeIn(CAIRO, 7);
    expect(to).toBe(DateTime.now().setZone(CAIRO).toISODate());
  });
});

describe('formatters', () => {
  it('reads hours the way a shift is spoken about', () => {
    expect(formatHours(8 * 3600)).toBe('8h');
    expect(formatHours(8 * 3600 + 20 * 60)).toBe('8h 20m');
    expect(formatHours(45 * 60)).toBe('45m');
  });

  it('shows nothing measured as a dash, never as zero', () => {
    expect(formatHours(null)).toBe('—');
    expect(formatHours(0)).toBe('—');
  });

  it('renders a shift time in the team zone', () => {
    expect(formatClock(at('09:05'), CAIRO)).toBe('09:05');
    expect(formatClock(null, CAIRO)).toBe('—');
  });

  it('says which side of on-time a drift is', () => {
    expect(formatDrift(12)).toBe('12m late');
    expect(formatDrift(-8)).toBe('8m early');
    expect(formatDrift(0)).toBe('on time');
    expect(formatDrift(null)).toBe('—');
  });
});
