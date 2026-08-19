import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { metricsDaily } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { asRows, computeDay, reportingContext } from '@/lib/reports/rollup';

/**
 * Nightly rollup into `metrics_daily`. The reports page reads only from here,
 * so opening it never runs an aggregate across the whole message history.
 *
 * The figures themselves are computed by `lib/reports/rollup`, which the live
 * dashboard also runs against today. This handler is only the storage half:
 * which days to recompute, and writing them.
 */

/**
 * How many days each run recomputes.
 *
 * Not just yesterday: a survey answered on Tuesday about a Monday ticket, or a
 * ticket resolved days after it arrived, both change an earlier day's numbers.
 * Recomputing a short window is cheaper than being subtly wrong for good.
 */
const RECOMPUTE_DAYS = 3;

export async function rollupMetrics(job?: ClaimedJob): Promise<void> {
  const requested = (job?.payload as { day?: string } | undefined)?.day;

  // Schedules, holidays, group overrides and policies read once for the whole
  // run rather than once per day: they are a dozen rows that every ticket in
  // every day of the window is measured against.
  const context = await reportingContext();

  const days = requested
    ? [requested]
    : Array.from({ length: RECOMPUTE_DAYS }, (_, offset) =>
        DateTime.now()
          .setZone(context.zone)
          .minus({ days: offset + 1 })
          .toISODate()!,
      );

  for (const day of days) {
    const rows = asRows(day, await computeDay(day, context));

    // Delete-then-insert rather than an upsert on the unique index: Postgres
    // treats NULLs as distinct in a unique index, so the "all" slices — which
    // are mostly NULLs — would never conflict and would accumulate a duplicate
    // row on every recompute.
    await db.transaction(async (tx) => {
      await tx.delete(metricsDaily).where(eq(metricsDaily.day, day));
      if (rows.length) await tx.insert(metricsDaily).values(rows);
    });

    console.log(`[rollup_metrics] ${day}: ${rows.length} rows`);
  }
}
