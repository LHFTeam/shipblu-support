import { describe, expect, it } from 'vitest';
import { countedThrough, uncounted } from './csat-queries';

const WINDOW = { from: '2026-09-18', to: '2026-10-17', zone: 'Africa/Cairo' };

// Which day counts as computed whole is `lastWholeDay`'s, against real
// Postgres (`queries.db.test.ts`); this is what the page does with it.
describe('countedThrough', () => {
  it('ends on the newest day the rollup computed whole', () => {
    expect(countedThrough(WINDOW, '2026-10-16')).toBe('2026-10-16');
    // After a night the run did not happen, further back rather than on a
    // day it has not computed.
    expect(countedThrough(WINDOW, '2026-10-14')).toBe('2026-10-14');
  });

  it('falls back to the day before yesterday until a run has written the record', () => {
    expect(countedThrough(WINDOW, null)).toBe('2026-10-15');
  });

  it('is calendar arithmetic, so a month boundary is a day like any other', () => {
    expect(countedThrough({ ...WINDOW, from: '2026-10-01', to: '2026-11-01' }, null)).toBe(
      '2026-10-30',
    );
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
