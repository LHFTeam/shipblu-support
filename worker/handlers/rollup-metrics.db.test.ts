import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversations,
  metricsDaily,
  rollupDays,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { computeDay, emptyBucket, type Slice } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { rollupMetrics } from './rollup-metrics';

// The real `computeDay`, which the tests of a refused day below replace for
// one call each, to hand the job the slices a broken accumulator or slice
// builder would. Nothing resets a mock between tests here, so each test's run
// must reach `computeDay` and use up its own replacement.
vi.mock('@/lib/reports/rollup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/rollup')>();
  return { ...actual, computeDay: vi.fn(actual.computeDay) };
});

/**
 * That a run records each day it computed, an empty one included.
 *
 * The reports ask `rollup_days` whether last night's run has reached
 * yesterday (`countedThrough`), because `metrics_daily` holds no row for a
 * day nobody worked. A run that wrote the marker only beside rows would put
 * the question back where it started: a quiet yesterday would read as a
 * night the job did not run.
 */

withCleanDatabase();

function job(payload: Record<string, unknown>): ClaimedJob {
  return { id: 'job-1', type: 'rollup_metrics', payload } as unknown as ClaimedJob;
}

describe('rollup_metrics', () => {
  it('records a day it computed, though the day held nothing to write', async () => {
    const before = new Date();
    await rollupMetrics(job({ day: '2026-10-14' }));

    expect(await db.select().from(metricsDaily)).toEqual([]);
    const [marker] = await db.select().from(rollupDays);
    expect(marker?.day).toBe('2026-10-14');
    expect(marker!.computedAt >= before).toBe(true);
  });

  it('moves the record forward when the day is computed again, and keeps one row for it', async () => {
    await db
      .insert(rollupDays)
      .values({ day: '2026-10-14', computedAt: new Date('2026-10-15T00:00:05Z') });

    await rollupMetrics(job({ day: '2026-10-14' }));

    const markers = await db.select().from(rollupDays);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.computedAt > new Date('2026-10-15T00:00:05Z')).toBe(true);
  });
});

/**
 * The category slice, written: a day holding a categorised ticket stores a row
 * naming that category, and a day computed again holds one row per slice —
 * the delete-and-insert replaces the day, and `metrics_daily_slice_key`
 * would refuse the second copy if it did not.
 */
describe('rollup_metrics, by category', () => {
  const DAY = '2026-10-14';

  // The `console.error` spies of a refused day's tests. Restored by the test
  // itself, a test failing before that line left its spy, calls and all, and
  // the next test's `spyOn` got it back and could match a line it never logged.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function categorisedTicket(): Promise<string> {
    const [sales] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'sales'));
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    await db.insert(conversations).values({
      channel: 'email',
      statusId: resolved!.id,
      requesterContactId: contact!.id,
      categoryId: sales!.id,
      createdAt: cairo('2026-10-14T10:00'),
      resolvedAt: cairo('2026-10-14T12:00'),
    });
    return sales!.id;
  }

  const slices = async () =>
    db
      .select({
        groupId: metricsDaily.groupId,
        agentId: metricsDaily.agentId,
        channel: metricsDaily.channel,
        categoryId: metricsDaily.categoryId,
        ticketsCreated: metricsDaily.ticketsCreated,
        ticketsResolved: metricsDaily.ticketsResolved,
      })
      .from(metricsDaily)
      .where(eq(metricsDaily.day, DAY));

  it("writes a row for the category a day's ticket is filed under", async () => {
    const sales = await categorisedTicket();
    await rollupMetrics(job({ day: DAY }));

    const rows = await slices();
    expect(rows.filter((row) => row.categoryId !== null)).toEqual([
      {
        groupId: null,
        agentId: null,
        channel: null,
        categoryId: sales,
        ticketsCreated: 1,
        ticketsResolved: 1,
      },
    ]);
    // Beside the totals and the ticket's channel, and nothing else: no group,
    // no assignee.
    expect(rows).toHaveLength(3);
  });

  it('leaves one row per slice when the day is computed again', async () => {
    await categorisedTicket();
    await rollupMetrics(job({ day: DAY }));
    const first = await slices();

    await rollupMetrics(job({ day: DAY }));
    const second = await slices();

    const key = (row: (typeof second)[number]) =>
      JSON.stringify([row.groupId, row.agentId, row.channel, row.categoryId]);
    expect(new Set(second.map(key)).size).toBe(second.length);
    expect(second).toHaveLength(first.length);
    expect(second).toEqual(expect.arrayContaining(first));
  });

  const all = { groupId: null, agentId: null, channel: null, categoryId: null };
  const bucket = (ticketsCreated: number) => ({ ...emptyBucket(), ticketsCreated });

  // Asked before the write: a day whose slices contradict each other is never
  // written, so it keeps what the last run to write it left, its marker
  // included, and the older days in the plan are still rebuilt.
  it('refuses a second totals row before writing, says which rule, and leaves the day as it was', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await categorisedTicket();
    await rollupMetrics(job({ day: DAY }));
    const before = await slices();
    const [marker] = await db.select().from(rollupDays);

    // What a round trip that dropped the category would hand back: the
    // category's figures as a second all-null slice. Checked after the write,
    // as it was, `metrics_daily_slice_key` refused it first, as a duplicate key
    // naming no slice, and the rule saying so in words was never reached.
    const twice: Slice[] = [
      { ...all, bucket: bucket(1) },
      { ...all, bucket: bucket(1) },
    ];
    vi.mocked(computeDay).mockResolvedValueOnce(twice);

    await expect(rollupMetrics(job({ day: DAY }))).rejects.toThrow(
      '1 day(s) failed the totals reconciliation and were not written',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(
        `${DAY}: totals do not match each other: 2 slices name no dimension, so the day is not written and keeps its previous rows`,
      ),
    );
    expect(await slices()).toEqual(expect.arrayContaining(before));
    expect(await slices()).toHaveLength(before.length);
    expect(await db.select().from(rollupDays)).toEqual([marker]);
  });

  it('writes nothing for a day whose category slices sum past its totals, and goes on to the older days', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sales = await categorisedTicket();
    await rollupMetrics(job({ day: DAY }));
    const before = await slices();
    const [marker] = await db.select().from(rollupDays);
    const [support] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'customer_support'));

    // One ticket filed under two categories: one in the totals, two in the
    // categories, which would print the report's "No category" as -1.
    vi.mocked(computeDay).mockResolvedValueOnce([
      { ...all, bucket: bucket(1) },
      { ...all, channel: 'email', bucket: bucket(1) },
      { ...all, categoryId: sales, bucket: bucket(1) },
      { ...all, categoryId: support!.id, bucket: bucket(1) },
    ]);

    // Newest first: the refused day, then the day before it, computed for real.
    await expect(rollupMetrics(job({ from: '2026-10-13', to: DAY }))).rejects.toThrow(
      '1 day(s) failed the totals reconciliation',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(
        `${DAY}: totals do not match the category slices, which sum past them in ticketsCreated, so the day is not written and keeps its previous rows`,
      ),
    );
    expect(await slices()).toHaveLength(before.length);
    expect(await slices()).toEqual(expect.arrayContaining(before));
    const markers = await db.select().from(rollupDays).orderBy(rollupDays.day);
    expect(markers.map((row) => row.day)).toEqual(['2026-10-13', DAY]);
    expect(markers[1]).toEqual(marker);
  });

  // A day no run wrote before has nothing to keep: no rows and no marker. Every
  // report but the CSAT page reads it as a day with nothing in it from that
  // night, so the line says which kind of refused day it is.
  it('says a refused day no run wrote before has no rows, and leaves it without rows or a marker', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(computeDay).mockResolvedValueOnce([
      { ...all, bucket: bucket(1) },
      { ...all, bucket: bucket(1) },
    ]);

    await expect(rollupMetrics(job({ day: DAY }))).rejects.toThrow(
      '1 day(s) failed the totals reconciliation and were not written',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(
        `${DAY}: totals do not match each other: 2 slices name no dimension, so the day is not written and has no rows until a run reconciles it`,
      ),
    );
    expect(await slices()).toEqual([]);
    expect(await db.select().from(rollupDays)).toEqual([]);
  });

  // Not caught per day: a slice a constraint refuses although it reconciles is
  // this job's own code built wrong, so every day would fail alike, and the
  // run should fail loudly. The day's transaction rolls back whole, so the day
  // keeps what the last good run wrote, its marker included.
  it.each([
    [
      'metrics_daily_slice_key',
      '23505',
      // One email slice built twice: the totals still equal the channels' sum.
      (): Slice[] => [
        { ...all, bucket: bucket(2) },
        { ...all, channel: 'email', bucket: bucket(1) },
        { ...all, channel: 'email', bucket: bucket(1) },
      ],
    ],
    [
      'metrics_daily_one_dimension',
      '23514',
      // A row naming a channel and a category: the only channel slice, and the
      // only category slice, so both sums agree with the totals.
      (sales: string): Slice[] => [
        { ...all, bucket: bucket(1) },
        { ...all, channel: 'email', categoryId: sales, bucket: bucket(1) },
      ],
    ],
  ])(
    'fails the run when %s refuses what reconciles, and rolls the day back whole',
    async (constraint, code, build) => {
      const sales = await categorisedTicket();
      await rollupMetrics(job({ day: DAY }));
      const before = await slices();
      const [marker] = await db.select().from(rollupDays);
      vi.mocked(computeDay).mockResolvedValueOnce(build(sales));

      await expect(rollupMetrics(job({ day: DAY }))).rejects.toMatchObject({
        cause: { code, constraint_name: constraint },
      });
      expect(await slices()).toEqual(expect.arrayContaining(before));
      expect(await slices()).toHaveLength(before.length);
      expect(await db.select().from(rollupDays)).toEqual([marker]);
    },
  );
});
