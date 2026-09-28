import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { metricsDaily } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { daily, rolledUpDays, totals } from './queries';

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

  it('says where the figures in the window start, and on how many days', async () => {
    await day('2026-09-24', 2);
    await day('2026-09-25', 3);

    expect(await rolledUpDays({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-24',
      days: 2,
    });
    expect(await rolledUpDays({ from: '2026-10-01', to: '2026-10-07' })).toEqual({
      first: null,
      days: 0,
    });
  });
});
