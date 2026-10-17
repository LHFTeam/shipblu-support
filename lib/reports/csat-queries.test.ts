import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { countedThrough, uncounted } from './csat-queries';

const WINDOW = { from: '2026-09-18', to: '2026-10-17', zone: 'Africa/Cairo' };
const at = (local: string) => DateTime.fromISO(local, { zone: WINDOW.zone }).toJSDate();
// The oldest write among the rows of the three days the nightly run rewrites.
const rolled = (recomputedAt: Date | null) => ({ recomputedAt });

describe('countedThrough', () => {
  it('ends on yesterday once tonight’s run has rewritten the three days', () => {
    expect(countedThrough(WINDOW, rolled(at('2026-10-17T03:00')))).toBe('2026-10-16');
  });

  it('ends the day before until then, rather than drawing yesterday as a day of zeros', () => {
    // The newest of them is from last night's run, at 03:00 on the 16th.
    expect(countedThrough(WINDOW, rolled(at('2026-10-16T03:00')))).toBe('2026-10-15');
  });

  it('is measured from the team’s midnight, not the database’s', () => {
    // 00:30 in Cairo on the 17th is still the 16th in UTC, and after the
    // team's midnight: a run then is tonight's.
    expect(countedThrough(WINDOW, rolled(at('2026-10-17T00:30')))).toBe('2026-10-16');
    expect(countedThrough(WINDOW, rolled(at('2026-10-16T23:30')))).toBe('2026-10-15');
  });

  it('stops a day early when the three days hold nothing to see', () => {
    // A quiet stretch: the runs happened and wrote nothing, so the page
    // stops on a day it can vouch for rather than one it cannot.
    expect(countedThrough(WINDOW, rolled(null))).toBe('2026-10-15');
  });

  it('is calendar arithmetic, so a month boundary is a day like any other', () => {
    const november = { ...WINDOW, from: '2026-10-01', to: '2026-11-01' };
    expect(countedThrough(november, rolled(at('2026-11-01T03:00')))).toBe('2026-10-31');
    expect(countedThrough(november, rolled(null))).toBe('2026-10-30');
  });
});

describe('uncounted', () => {
  const day = (on: string, sent: number, skipped: number) => ({ day: on, sent, skipped });
  const row = (on: string, csatSentCount: number, csatSkippedCount: number) => ({
    day: on,
    csatSentCount,
    csatSkippedCount,
  });

  it('names each day the live counts hold more on, and by how much', () => {
    expect(
      uncounted(
        [day('2026-08-31', 1, 0), day('2026-09-02', 3, 2), day('2026-09-03', 4, 1)],
        [row('2026-09-02', 1, 2), row('2026-09-03', 4, 1)],
      ),
    ).toEqual({ sent: 3, skipped: 0, days: [day('2026-08-31', 1, 0), day('2026-09-02', 2, 0)] });
  });

  it('counts decisions against as well as sends', () => {
    expect(uncounted([day('2026-09-02', 0, 4)], [row('2026-09-02', 0, 0)])).toEqual({
      sent: 0,
      skipped: 4,
      days: [day('2026-09-02', 0, 4)],
    });
  });

  it('does not set a day the rollup holds more on against a day it is short', () => {
    // The rollup still counts a survey since purged on the 5th; the 31st's
    // send is missing all the same.
    expect(
      uncounted(
        [day('2026-08-31', 1, 0), day('2026-10-05', 0, 0)],
        [row('2026-08-31', 0, 0), row('2026-10-05', 1, 0)],
      ),
    ).toEqual({ sent: 1, skipped: 0, days: [day('2026-08-31', 1, 0)] });
  });

  it('finds nothing when every day agrees', () => {
    expect(uncounted([day('2026-09-02', 2, 1)], [row('2026-09-02', 2, 1)])).toEqual({
      sent: 0,
      skipped: 0,
      days: [],
    });
  });
});
