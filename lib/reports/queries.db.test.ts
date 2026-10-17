import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { metricsDaily } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { byChannel, daily, rolledUpDays, totals } from './queries';

/**
 * The reports overview's window. The queries used to turn a day count into a
 * UTC date with no upper bound; they now take the `{ from, to }` the page
 * resolved, both ends included, so what is counted is exactly what the header
 * prints.
 */

withCleanDatabase();

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
      last: '2026-09-25',
      days: 2,
      recomputedAt: null,
    });
    expect(await rolledUpDays({ from: '2026-10-01', to: '2026-10-07' })).toEqual({
      first: '2026-09-24',
      last: '2026-09-25',
      days: 0,
      recomputedAt: null,
    });
    expect(await rolledUpDays({ from: '2026-09-01', to: '2026-09-20' })).toEqual({
      first: null,
      last: null,
      days: 0,
      recomputedAt: null,
    });
    // The newest day rolled up so far, never one after the window: what a
    // live read checked against the figures stops at.
    expect((await rolledUpDays({ from: '2026-09-20', to: '2026-09-24' })).last).toBe('2026-09-24');
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

    expect(rolledUp).toEqual({
      first: '2026-08-18',
      last: '2026-08-23',
      days: 2,
      recomputedAt: expect.any(Date),
    });
    expect(rolledUp.first! > range.from).toBe(false);
  });

  it('says when every row of the three days the nightly run rewrites was written', async () => {
    const written = (on: string, iso: string) =>
      db.insert(metricsDaily).values({ day: on, ticketsCreated: 1, computedAt: new Date(iso) });
    const window = { from: '2026-09-18', to: '2026-10-17' };

    // Tonight's run, at 00:00 UTC on the 17th, rewrote the 14th and 15th;
    // nobody worked on the 16th. The 13th is before the three days, and a
    // partial row for today, written by hand, is after them.
    await written('2026-10-13', '2026-10-15T00:00:05Z');
    await written('2026-10-14', '2026-10-17T00:00:05Z');
    await written('2026-10-15', '2026-10-17T00:00:06Z');
    await written('2026-10-17', '2026-10-17T09:00:00Z');
    expect((await rolledUpDays(window)).recomputedAt).toEqual(new Date('2026-10-17T00:00:05Z'));

    // Before tonight's run, one of the three rewritten by hand after the
    // team's midnight is not the run: the oldest is still last night's.
    await db.delete(metricsDaily);
    await written('2026-10-14', '2026-10-16T00:00:05Z');
    await written('2026-10-15', '2026-10-16T22:00:00Z');
    expect((await rolledUpDays(window)).recomputedAt).toEqual(new Date('2026-10-16T00:00:05Z'));
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
