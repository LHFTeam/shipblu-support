import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { categoryMetricsDaily, rootCauseMetricsDaily } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { rolledUpRange } from './category-queries';

/**
 * Where the categorised history starts. A day nobody worked has no row in
 * either rollup, so a window opening on one must not be reported as the
 * history starting inside it when it reaches further back.
 */

withCleanDatabase();

async function category(day: string) {
  await db
    .insert(categoryMetricsDaily)
    .values({ day, categoryKey: 'wismo', area: 'delivery', channel: 'email', ticketsAny: 1 });
}

async function cause(day: string) {
  await db
    .insert(rootCauseMetricsDaily)
    .values({ day, causeKey: 'courier_delay', owner: 'courier', channel: 'email' });
}

describe('rolledUpRange', () => {
  it('takes the start of the history from before the window, past a quiet first day', async () => {
    await category('2026-08-18');
    await cause('2026-08-19');
    // Nothing on the 20th, in either table: the window below opens on a gap.
    await category('2026-08-21');
    await cause('2026-08-23');

    expect(await rolledUpRange({ from: '2026-08-20', to: '2026-08-25' })).toEqual({
      first: '2026-08-18',
      last: '2026-08-23',
      days: 2,
    });
  });

  it('still reports a history that really starts inside the window', async () => {
    await cause('2026-09-24');
    await category('2026-09-25');

    expect(await rolledUpRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-24',
      last: '2026-09-25',
      days: 2,
    });
  });

  it('counts a day once when both tables have it, and nothing after the window', async () => {
    await category('2026-09-10');
    await cause('2026-09-10');
    await category('2026-10-02');

    expect(await rolledUpRange({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      first: '2026-09-10',
      last: '2026-09-10',
      days: 1,
    });
  });

  it('answers null for a window before any history', async () => {
    await category('2026-09-10');

    expect(await rolledUpRange({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      first: null,
      last: null,
      days: 0,
    });
  });
});
