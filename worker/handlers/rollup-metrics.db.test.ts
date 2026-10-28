import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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

// The real `computeDay`, which one test below replaces for a single call to
// hand the job the slices a broken accumulator would.
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

  // Not caught per day: a slice the key refuses is this job's own code built
  // wrong, so every day would fail alike, and the run should fail loudly. The
  // day's transaction rolls back whole, so the day keeps what the last good
  // run wrote, its marker included.
  it('fails the run on a refused slice, and leaves the day as the last good run wrote it', async () => {
    await categorisedTicket();
    await rollupMetrics(job({ day: DAY }));
    const before = await slices();
    const [marker] = await db.select().from(rollupDays);

    // What a round trip that dropped the category would hand back: the
    // category's figures as a second all-null slice.
    const all = { groupId: null, agentId: null, channel: null, categoryId: null };
    const twice: Slice[] = [
      { ...all, bucket: { ...emptyBucket(), ticketsCreated: 1 } },
      { ...all, bucket: { ...emptyBucket(), ticketsCreated: 1 } },
    ];
    vi.mocked(computeDay).mockResolvedValueOnce(twice);

    await expect(rollupMetrics(job({ day: DAY }))).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'metrics_daily_slice_key' },
    });
    expect(await slices()).toEqual(expect.arrayContaining(before));
    expect(await slices()).toHaveLength(before.length);
    expect(await db.select().from(rollupDays)).toEqual([marker]);
  });
});
