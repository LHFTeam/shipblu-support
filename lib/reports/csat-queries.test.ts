import { describe, expect, it } from 'vitest';
import { countedThrough, uncounted } from './csat-queries';

const RANGE = { from: '2026-09-18', to: '2026-10-17' };

describe('countedThrough', () => {
  it('ends on yesterday once tonight’s run has written it', () => {
    expect(countedThrough(RANGE, '2026-10-16')).toBe('2026-10-16');
  });

  it('ends the day before until then, rather than drawing yesterday as a day of zeros', () => {
    expect(countedThrough(RANGE, '2026-10-15')).toBe('2026-10-15');
  });

  it('does not take the last day anybody worked for the last day rolled up', () => {
    // A quiet week: the runs happened, and wrote nothing.
    expect(countedThrough(RANGE, '2026-10-09')).toBe('2026-10-15');
    expect(countedThrough(RANGE, null)).toBe('2026-10-15');
  });

  it('counts a partial row for today, written by hand, as nothing past yesterday', () => {
    expect(countedThrough(RANGE, '2026-10-17')).toBe('2026-10-16');
  });

  it('is calendar arithmetic, so a month boundary is a day like any other', () => {
    expect(countedThrough({ from: '2026-10-01', to: '2026-11-01' }, '2026-10-31')).toBe(
      '2026-10-31',
    );
    expect(countedThrough({ from: '2026-10-01', to: '2026-11-01' }, null)).toBe('2026-10-30');
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
