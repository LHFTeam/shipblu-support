import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, groups, metricsDaily, rollupDays, ticketCategories } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  byCategory,
  byChannel,
  categorisedFrom,
  daily,
  lastWholeDay,
  rolledUpDays,
  TOTALS_SLICE,
  totals,
} from './queries';

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

/** The four starter categories the baseline seeds, by key. */
async function categoryIds() {
  const rows = await db
    .select({ key: ticketCategories.key, id: ticketCategories.id })
    .from(ticketCategories);
  const id = (key: string) => rows.find((row) => row.key === key)!.id;
  return {
    sales: id('sales'),
    customerSupport: id('customer_support'),
    merchantSupport: id('merchant_support'),
    courierJobs: id('courier_jobs'),
  };
}

describe('the totals slice', () => {
  // A category slice is the totals row with one more dimension filled in, so
  // a totals reader naming only the other three nulls takes it for a second
  // totals row and counts every categorised ticket twice.
  it('leaves totals, the daily series and the history’s start as they were beside a category slice', async () => {
    const { sales, courierJobs } = await categoryIds();
    await db.insert(metricsDaily).values([
      { day: '2026-10-12', ticketsCreated: 5, csatSentCount: 2, csatRating5: 1 },
      { day: '2026-10-13', ticketsCreated: 4, firstResponseSecondsSum: 600, firstResponseCount: 2 },
    ]);
    const range = { from: '2026-10-11', to: '2026-10-13' };
    const before = {
      totals: await totals(range),
      daily: await daily(range),
      rolledUp: await rolledUpDays(range),
    };
    expect(before.totals.ticketsCreated).toBe(9);
    expect(before.rolledUp).toEqual({ first: '2026-10-12', days: 2 });

    await db.insert(metricsDaily).values([
      { day: '2026-10-12', categoryId: sales, ticketsCreated: 3, csatSentCount: 1, csatRating5: 1 },
      { day: '2026-10-13', categoryId: sales, ticketsCreated: 1, firstResponseSecondsSum: 300 },
      { day: '2026-10-13', categoryId: courierJobs, ticketsCreated: 2, firstResponseCount: 1 },
      // On a day with no totals row, which the rollup never writes — here only
      // so the history's start and its count of days can see a reader that
      // takes a category slice for a totals day.
      { day: '2026-10-11', categoryId: sales, ticketsCreated: 7 },
    ]);

    expect(await totals(range)).toEqual(before.totals);
    expect(await daily(range)).toEqual(before.daily);
    expect(await rolledUpDays(range)).toEqual(before.rolledUp);
  });

  it('is one row a day: every single-dimension slice beside it is outside it', async () => {
    const { sales } = await categoryIds();
    const [group] = await db.select({ id: groups.id }).from(groups).limit(1);
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'omar@shipblu.test' })
      .returning({ id: agents.id });
    const day = '2026-10-12';
    const [total] = await db
      .insert(metricsDaily)
      .values({ day, ticketsCreated: 10 })
      .returning({ id: metricsDaily.id });
    await db.insert(metricsDaily).values([
      { day, groupId: group!.id, ticketsCreated: 10 },
      { day, agentId: agent!.id, ticketsCreated: 10 },
      { day, channel: 'email', ticketsCreated: 10 },
      { day, categoryId: sales, ticketsCreated: 10 },
    ]);

    expect(await db.select({ id: metricsDaily.id }).from(metricsDaily).where(TOTALS_SLICE)).toEqual(
      [{ id: total!.id }],
    );
  });
});

describe('byCategory', () => {
  it('sums each category over the window, in the registry’s order, a retired one included', async () => {
    const { sales, customerSupport, merchantSupport, courierJobs } = await categoryIds();
    // An order that is neither the seed's nor the figures': courier jobs
    // first, then sales and merchant support tied on position and so by key,
    // then customer support.
    const position = (id: string, value: number) =>
      db.update(ticketCategories).set({ position: value }).where(eq(ticketCategories.id, id));
    await position(courierJobs, 0);
    await position(sales, 1);
    await position(merchantSupport, 1);
    await position(customerSupport, 2);
    // Retired since its tickets were rolled up: they still report under it.
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.id, merchantSupport));

    await db.insert(metricsDaily).values([
      { day: '2026-10-12', ticketsCreated: 30, ticketsResolved: 20 },
      { day: '2026-10-12', categoryId: customerSupport, ticketsCreated: 9, ticketsResolved: 1 },
      { day: '2026-10-13', categoryId: customerSupport, ticketsCreated: 1, ticketsResolved: 4 },
      { day: '2026-10-12', categoryId: sales, ticketsCreated: 2, csatRatingSum: 9 },
      { day: '2026-10-13', categoryId: sales, ticketsCreated: 3, csatRatingSum: 5 },
      { day: '2026-10-13', categoryId: merchantSupport, ticketsCreated: 4 },
      { day: '2026-10-13', categoryId: courierJobs, firstResponseCount: 1 },
      // Outside the window.
      { day: '2026-10-14', categoryId: sales, ticketsCreated: 100 },
      { day: '2026-10-11', categoryId: customerSupport, ticketsCreated: 100 },
    ]);

    const { rows, rest } = await byCategory({ from: '2026-10-12', to: '2026-10-13' });

    expect(
      rows.map(({ label, isActive, ticketsCreated, ticketsResolved, csatRatingSum }) => ({
        label,
        isActive,
        ticketsCreated,
        ticketsResolved,
        csatRatingSum,
      })),
    ).toEqual([
      {
        label: 'Courier jobs',
        isActive: true,
        ticketsCreated: 0,
        ticketsResolved: 0,
        csatRatingSum: 0,
      },
      {
        label: 'Merchant support',
        isActive: false,
        ticketsCreated: 4,
        ticketsResolved: 0,
        csatRatingSum: 0,
      },
      { label: 'Sales', isActive: true, ticketsCreated: 5, ticketsResolved: 0, csatRatingSum: 14 },
      {
        label: 'Customer support',
        isActive: true,
        ticketsCreated: 10,
        ticketsResolved: 5,
        csatRatingSum: 0,
      },
    ]);
    expect(rows[0]!.firstResponseCount).toBe(1);
    // The window's totals less the four rows: 30 - 19 created, 20 - 5 resolved.
    expect(rest).toMatchObject({ ticketsCreated: 11, ticketsResolved: 15 });
  });

  it('has no row for a category with no slice in the window, and leaves the totals as the rest', async () => {
    await db.insert(metricsDaily).values({ day: '2026-10-12', ticketsCreated: 3 });
    expect(await byCategory({ from: '2026-10-12', to: '2026-10-13' })).toEqual({
      rows: [],
      rest: expect.objectContaining({ ticketsCreated: 3 }),
    });
  });

  // The rest is a subtraction, so its two halves are read in one statement:
  // read apart, a rollup committing a day between them took that night's
  // category figures off totals that did not yet hold it.
  it('reads the rest of the totals in the statement that reads the categories', async () => {
    const { sales, customerSupport } = await categoryIds();
    const [group] = await db.insert(groups).values({ name: 'Sales team' }).returning();
    await db.insert(metricsDaily).values([
      { day: '2026-10-12', ticketsCreated: 10, csatRating5: 3 },
      { day: '2026-10-12', categoryId: sales, ticketsCreated: 4, csatRating5: 1 },
      { day: '2026-10-13', ticketsCreated: 5 },
      { day: '2026-10-13', categoryId: customerSupport, ticketsCreated: 5 },
      // Other cuts' slices, which are not the totals however many nulls they hold.
      { day: '2026-10-12', channel: 'email', ticketsCreated: 10 },
      { day: '2026-10-12', groupId: group!.id, ticketsCreated: 7 },
      // Outside the window.
      { day: '2026-10-14', ticketsCreated: 100 },
    ]);

    const { rows, rest } = await byCategory({ from: '2026-10-12', to: '2026-10-13' });

    expect(rows.map((row) => [row.label, row.ticketsCreated])).toEqual(
      expect.arrayContaining([
        ['Sales', 4],
        ['Customer support', 5],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rest).toMatchObject({ ticketsCreated: 6, csatRating5: 2 });
  });
});

describe('categorisedFrom', () => {
  it('names the first category slice on or before the window’s end, however far before its start', async () => {
    const { sales, courierJobs } = await categoryIds();
    const range = { from: '2026-10-10', to: '2026-10-13' };
    await db.insert(metricsDaily).values({ day: '2026-09-01', ticketsCreated: 1 });
    expect(await categorisedFrom(range)).toBeNull();

    // After the window's end: not where its figures start.
    await db
      .insert(metricsDaily)
      .values({ day: '2026-10-14', categoryId: sales, ticketsCreated: 1 });
    expect(await categorisedFrom(range)).toBeNull();

    await db
      .insert(metricsDaily)
      .values({ day: '2026-10-12', categoryId: sales, ticketsCreated: 1 });
    expect(await categorisedFrom(range)).toBe('2026-10-12');

    // Before the window opens, and still the answer: a window whose first days
    // are quiet must not read as the day category figures began.
    await db
      .insert(metricsDaily)
      .values({ day: '2026-09-02', categoryId: courierJobs, ticketsCreated: 1 });
    expect(await categorisedFrom(range)).toBe('2026-09-02');
  });
});
