import { DateTime } from 'luxon';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { metricsDaily } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import {
  asRows,
  computeDay,
  earliestDay,
  reconciles,
  reportingContext,
} from '@/lib/reports/rollup';

/**
 * Nightly rollup into `metrics_daily`. The reports page reads only from here,
 * so opening it never runs an aggregate across the whole message history.
 *
 * The figures themselves are computed by `lib/reports/rollup`, which the live
 * dashboard also runs against today. This handler is only the storage half:
 * which days to recompute, and writing them.
 */

/**
 * How many days each unattended run recomputes.
 *
 * Not just yesterday: a survey answered on Tuesday about a Monday ticket, or a
 * ticket resolved days after it arrived, both change an earlier day's numbers.
 * Recomputing a short window is cheaper than being subtly wrong for good.
 */
const RECOMPUTE_DAYS = 3;

/**
 * The most days one invocation will rebuild.
 *
 * A backfill is the one path here that can be handed an arbitrary span, and a
 * mistyped year should not turn into a job that walks a decade. What is skipped
 * is logged rather than dropped quietly — a truncated rebuild that reported
 * success would leave exactly the silently-wrong days this job exists to fix.
 */
const MAX_DAYS = 400;

export type RollupPayload = {
  /** A single day, as `YYYY-MM-DD`. */
  day?: string;
  /** Range start, inclusive. Defaults to the oldest day with any data. */
  from?: string;
  /** Range end, inclusive. Clamped to yesterday — today is never complete. */
  to?: string;
  /** The last N complete days, as an alternative to naming `from`. */
  days?: number;
};

export type DayPlan = { days: string[]; skipped: number };

/**
 * Which days a run rebuilds.
 *
 * Pure, and separated from the work, because every way of getting this wrong is
 * quiet: rebuilding one day too few leaves a wrong row in place, and rebuilding
 * today writes a half-finished day into the table the reports page treats as
 * complete.
 *
 * `to` is clamped to yesterday for that second reason. The dashboard already
 * shows today live, computed from the same code, so there is nothing to gain by
 * storing a partial day and a real report to lose.
 */
export function planDays(
  payload: RollupPayload,
  bounds: { today: string; earliest: string | null },
  zone: string,
): DayPlan {
  const yesterday = DateTime.fromISO(bounds.today, { zone }).minus({ days: 1 });

  if (payload.day) return { days: [payload.day], skipped: 0 };

  const wantsRange =
    payload.from !== undefined || payload.to !== undefined || payload.days !== undefined;

  if (!wantsRange) {
    // The cron path: yesterday and the two days behind it, newest first.
    return {
      days: Array.from({ length: RECOMPUTE_DAYS }, (_, offset) =>
        yesterday.minus({ days: offset }).toISODate()!,
      ),
      skipped: 0,
    };
  }

  const requestedEnd = payload.to ? DateTime.fromISO(payload.to, { zone }) : yesterday;
  const end = requestedEnd > yesterday ? yesterday : requestedEnd;

  const start = payload.days
    ? end.minus({ days: Math.max(1, Math.floor(payload.days)) - 1 })
    : payload.from
      ? DateTime.fromISO(payload.from, { zone })
      : // No start given and no data to bound it: fall back to the cron window
        // rather than to the beginning of time.
        bounds.earliest
        ? DateTime.fromISO(bounds.earliest, { zone })
        : end.minus({ days: RECOMPUTE_DAYS - 1 });

  if (!start.isValid || !end.isValid || start > end) return { days: [], skipped: 0 };

  const span = Math.floor(end.diff(start, 'days').days) + 1;
  const kept = Math.min(span, MAX_DAYS);

  // Newest first, so a truncated rebuild fixes the days most likely to be read.
  return {
    days: Array.from({ length: kept }, (_, offset) => end.minus({ days: offset }).toISODate()!),
    skipped: span - kept,
  };
}

/**
 * Rebuild `metrics_daily`.
 *
 * With no payload this is the nightly job. Given `day`, `from`/`to` or `days`
 * it is a backfill — which is how a stretch of history that was written by a
 * buggy version gets repaired, since the figures are always recomputed from the
 * source tables rather than adjusted in place.
 */
export async function rollupMetrics(job?: ClaimedJob): Promise<void> {
  const payload = (job?.payload ?? {}) as RollupPayload;

  // Schedules, holidays, group overrides and policies read once for the whole
  // run rather than once per day: they are a dozen rows that every ticket in
  // every day of the window is measured against.
  const context = await reportingContext();

  const plan = planDays(
    payload,
    {
      today: DateTime.now().setZone(context.zone).toISODate()!,
      earliest: await earliestDay(context.zone),
    },
    context.zone,
  );

  if (plan.skipped > 0) {
    console.warn(
      `[rollup_metrics] range exceeds ${MAX_DAYS} days — rebuilding the most recent ${plan.days.length} and skipping ${plan.skipped} older. Re-run with an earlier "to" to finish the rest.`,
    );
  }

  if (plan.days.length === 0) {
    console.log('[rollup_metrics] nothing to rebuild for this range');
    return;
  }

  let inconsistent = 0;

  for (const day of plan.days) {
    const slices = await computeDay(day, context);
    const rows = asRows(day, slices);

    // Delete-then-insert rather than an upsert on the unique index: Postgres
    // treats NULLs as distinct in a unique index, so the "all" slices — which
    // are mostly NULLs — would never conflict and would accumulate a duplicate
    // row on every recompute.
    await db.transaction(async (tx) => {
      await tx.delete(metricsDaily).where(eq(metricsDaily.day, day));
      if (rows.length) await tx.insert(metricsDaily).values(rows);
    });

    // Asserted on every write, not just on backfills: a day whose totals do not
    // equal the sum of its own channel slices is the exact shape of the bug
    // this job once shipped, and it is invisible in the output.
    if (!reconciles(slices)) {
      inconsistent += 1;
      console.error(`[rollup_metrics] ${day}: totals do not match the sum of the channel slices`);
    }

    console.log(`[rollup_metrics] ${day}: ${rows.length} rows`);
  }

  console.log(
    `[rollup_metrics] rebuilt ${plan.days.length} day(s), ${plan.days.at(-1)} to ${plan.days[0]}`,
  );

  // Fail the run rather than reporting success over numbers that contradict
  // themselves: a green nightly job is the only signal anyone watches.
  if (inconsistent > 0) {
    throw new Error(`[rollup_metrics] ${inconsistent} day(s) failed the totals reconciliation`);
  }
}
