import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { metricsDaily, rollupDays } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { byChannel, daily, lastWholeDay, rolledUpDays, totals } from './queries';

/**
 * The reports overview's window. The queries used to turn a day count into a
 * UTC date with no upper bound; they now take the `{ from, to }` the page
 * resolved, both ends included, so what is counted is exactly what the header
 * prints.
 */

withCleanDatabase();

const ZONE = 'Africa/Cairo';

async function day(value: string, ticketsCreated: number) {
  await db.insert(metricsDaily).values({ day: value, ticketsCreated });
}

describe('the reports window', () => {
  it('counts the days from `from` to `to`, both included, and nothing outside', async () => {
    await day('2026-09-19', 100); // the day before the window
    await day('2026-09-20', 1); // `from`
    await day('2026-09-24', 2);
    await day('2026-09-26', 4); // `to`
    await day('2026-09-27', 1000); // the day after

    const range = { from: '2026-09-20', to: '2026-09-26' };

    expect((await totals(range)).ticketsCreated).toBe(7);
    expect((await daily(range)).map((row) => row.day)).toEqual([
      '2026-09-20',
      '2026-09-24',
      '2026-09-26',
    ]);
  });

  it('says where the history starts, and on how many days of the window there are figures', async () => {
    await day('2026-09-24', 2);
    await day('2026-09-25', 3);

    expect(await rolledUpDays({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-24',
      days: 2,
    });
    expect(await rolledUpDays({ from: '2026-10-01', to: '2026-10-07' })).toEqual({
      first: '2026-09-24',
      days: 0,
    });
    expect(await rolledUpDays({ from: '2026-09-01', to: '2026-09-20' })).toEqual({
      first: null,
      days: 0,
    });
  });

  // A day nobody worked has no row. A window opening on one must not report
  // the history as starting inside it when it reaches further back.
  it('takes the start of the history from before the window, past a quiet first day', async () => {
    await day('2026-08-18', 5);
    await day('2026-08-19', 5);
    // Nothing on the 20th: the window below opens on a gap.
    await day('2026-08-21', 5);
    await day('2026-08-23', 5);

    const range = { from: '2026-08-20', to: '2026-08-25' };
    const rolledUp = await rolledUpDays(range);

    expect(rolledUp).toEqual({ first: '2026-08-18', days: 2 });
    expect(rolledUp.first! > range.from).toBe(false);
  });

  it('names the newest day computed after it ended, in the team’s zone, before the window’s end', async () => {
    const at = (local: string) => DateTime.fromISO(local, { zone: ZONE }).toJSDate();
    const computed = (day: string, local: string) =>
      db.insert(rollupDays).values({ day, computedAt: at(local) });
    const window = { from: '2026-09-18', to: '2026-10-17', zone: ZONE };
    expect(await lastWholeDay(window)).toBeNull();

    // Last night's run reached the 15th; a hand run of the 16th at 18:00
    // that day read a day still going, and a hand run of today is today's.
    await computed('2026-10-14', '2026-10-15T02:00');
    await computed('2026-10-15', '2026-10-16T02:00');
    await computed('2026-10-16', '2026-10-16T18:00');
    await computed('2026-10-17', '2026-10-17T09:00');
    expect(await lastWholeDay(window)).toBe('2026-10-15');

    // Tonight's run began at 00:30 in Cairo: still the 16th in UTC, and after
    // the team's midnight, so the 16th was over.
    await db.delete(rollupDays).where(eq(rollupDays.day, '2026-10-16'));
    await computed('2026-10-16', '2026-10-17T00:30');
    expect(await lastWholeDay(window)).toBe('2026-10-16');

    // Begun at 23:30 on the 16th, it is not.
    await db.delete(rollupDays).where(eq(rollupDays.day, '2026-10-16'));
    await computed('2026-10-16', '2026-10-16T23:30');
    expect(await lastWholeDay(window)).toBe('2026-10-15');

    // A night the run did not happen leaves no record, and the newest whole
    // day is further back.
    await db.delete(rollupDays).where(eq(rollupDays.day, '2026-10-15'));
    await db.delete(rollupDays).where(eq(rollupDays.day, '2026-10-16'));
    expect(await lastWholeDay(window)).toBe('2026-10-14');
  });
});

describe('the survey columns', () => {
  it('sums the sends, the skips and each step of the scale over the window', async () => {
    const surveys = {
      csatSentCount: 4,
      csatSkippedCount: 1,
      csatRating1: 1,
      csatRating4: 1,
      csatRating5: 2,
      csatResponseCount: 4,
      csatRatingSum: 15,
    };
    await db.insert(metricsDaily).values([
      { day: '2026-10-12', ...surveys },
      { day: '2026-10-13', ...surveys, csatRating4: 0, csatRating5: 3 },
      { day: '2026-10-13', channel: 'email', ...surveys },
      // Outside the window.
      { day: '2026-10-14', ...surveys },
    ]);

    expect(await totals({ from: '2026-10-12', to: '2026-10-13' })).toMatchObject({
      csatSentCount: 8,
      csatSkippedCount: 2,
      csatRating1: 2,
      csatRating2: 0,
      csatRating3: 0,
      csatRating4: 1,
      csatRating5: 5,
      csatResponseCount: 8,
    });
    expect(await byChannel({ from: '2026-10-12', to: '2026-10-13' })).toMatchObject([
      { label: 'email', csatSentCount: 4, csatRating5: 2 },
    ]);
  });
});
