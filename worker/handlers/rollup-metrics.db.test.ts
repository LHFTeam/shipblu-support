import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { metricsDaily, rollupDays } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { rollupMetrics } from './rollup-metrics';

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
