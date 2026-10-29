import { DateTime } from 'luxon';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentMetricsDaily,
  subcategoryMetricsDaily,
  metricsDaily,
  rollupDays,
  rootCauseMetricsDaily,
} from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload, type JobPayload } from '@/lib/queue/payloads';
import { computeAgentDay, withActivity } from '@/lib/reports/agent-rollup';
import { TOTALS_SLICE } from '@/lib/reports/queries';
import { computeSubcategoryDay, computeRootCauseDay } from '@/lib/reports/subcategory-rollup';
import {
  asRows,
  computeDay,
  earliestDay,
  reconcileFailure,
  reportingContext,
} from '@/lib/reports/rollup';
import { logger } from '@/lib/log';

const log = logger('rollup_metrics');

/**
 * Nightly rollup into `metrics_daily`. The reports page reads only from here,
 * so opening it never runs an aggregate across the whole message history.
 *
 * The figures themselves are computed by `lib/reports/rollup`, which the live
 * dashboard also runs against today. This handler is only the storage half:
 * which days to recompute, and writing them.
 *
 * It writes four tables and a marker. `metrics_daily` measures tickets, sliced
 * five ways; `agent_metrics_daily` measures the people, one row per agent per
 * day; `subcategory_metrics_daily` and `root_cause_metrics_daily` what the
 * tickets were about and why; and `rollup_days` records that the day was
 * computed. They are separate tables for reasons `db/schema/metrics.ts` sets out, but they are
 * deliberately one job: two nightly jobs would be two answers to "which day is
 * this", and the first daylight-saving change or late-running cron would make
 * an agent's shift and the tickets they closed during it land on different
 * dates.
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

/** What a run may name. The schema in `lib/queue/payloads.ts` documents each field. */
export type RollupPayload = JobPayload<'rollup_metrics'>;

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

  // Counted on the calendar dates, not the instants between them. A range that
  // starts on a Cairo spring-forward day starts at 01:00, so luxon's day diff
  // from it to the next midnight is 23 hours rather than a day, and flooring it
  // dropped that day with nothing in `skipped` to say so
  // (`docs/PROJECT-STATE.md` §6.101).
  const span = datesFrom(start, end) + 1;
  const kept = Math.min(span, MAX_DAYS);

  // Newest first, so a truncated rebuild fixes the days most likely to be read.
  return {
    days: Array.from({ length: kept }, (_, offset) => end.minus({ days: offset }).toISODate()!),
    skipped: span - kept,
  };
}

/** How many dates `end`'s is after `start`'s, read as dates in UTC as `windowDays` reads them. */
function datesFrom(start: DateTime, end: DateTime): number {
  const date = (at: DateTime) => DateTime.fromISO(at.toISODate()!, { zone: 'utc' });
  return date(end).diff(date(start), 'days').days;
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
  const payload: RollupPayload = job ? parseJobPayload(job, 'rollup_metrics') : {};

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
    log.warn(
      `range exceeds ${MAX_DAYS} days — rebuilding the most recent ${plan.days.length} and skipping ${plan.skipped} older. Re-run with an earlier "to" to finish the rest.`,
    );
  }

  if (plan.days.length === 0) {
    log.info('nothing to rebuild for this range');
    return;
  }

  let inconsistent = 0;

  for (const day of plan.days) {
    // When the day's reads began, which is what `rollup_days` records: a run
    // stamped when it committed could read before the day ended and still
    // pass for one that read it whole.
    const startedAt = new Date();
    const slices = await computeDay(day, context);

    // Asked before anything is written, on every run and not just on
    // backfills. Each rule `reconcileFailure` checks is a bug that is invisible
    // in the output — a totals row that reads high looks like a busy day, not
    // like a bug, and category slices summing past it print the overview's
    // "No category" negative — so a day that breaks one is not written at all:
    // its transaction is never opened, and the day keeps the rows, the agent
    // rows and the marker the last run to write it left. Checked after the
    // write, as it was, the day was published and only the run failed, and
    // the rule against a second totals row could never be reached:
    // `metrics_daily_slice_key` refused that row first, as a duplicate key
    // naming no slice. Counted and carried on rather than thrown, unlike a
    // refused insert below: whether the older days agree is worth knowing from
    // the same run, which still fails at the end.
    // A day no run wrote before has nothing to keep, and that is the cost of
    // refusing it: every report but the CSAT page reads up to today — the
    // overview, the dashboard's History, agents, subcategories — and so reads
    // it as a day with nothing in it from the night it is refused. The CSAT
    // page stops short of it, at `countedThrough`, and only until a later day
    // is written: that is the newest day computed whole, not the end of an
    // unbroken run of them, so the day is then a gap there too, which only its
    // `uncounted` names, and only for surveys. So the line says which of the
    // two the day is. The nightly retries it while it is one of its three days;
    // after that, `rollup_metrics day=<day>` once the cause is fixed is what
    // writes it.
    // Not extended to the subcategory and root-cause tables, and the absence
    // is deliberate rather than an oversight: they have no totals row to
    // reconcile against, because a ticket carrying three subcategories appears
    // under three of them. That is also exactly why they are not a dimension on
    // `metrics_daily` — see `db/schema/metrics.ts`.
    const failure = reconcileFailure(slices);
    if (failure) {
      inconsistent += 1;
      const kept = await db
        .select({ day: metricsDaily.day })
        .from(metricsDaily)
        .where(and(eq(metricsDaily.day, day), TOTALS_SLICE))
        .limit(1);
      log.error(
        `${day}: totals do not match ${failure}, so the day is not written and ${
          kept.length > 0 ? 'keeps its previous rows' : 'has no rows until a run reconciles it'
        }`,
      );
      continue;
    }

    const rows = asRows(day, slices);
    const agentRows = withActivity(await computeAgentDay(day, context));
    const subcategoryRows = await computeSubcategoryDay(day, context);
    const causeRows = await computeRootCauseDay(day, context);

    // Delete-then-insert rather than an upsert on the slice key. The key can
    // be a conflict target now — `metrics_daily_slice_key` is NULLS NOT
    // DISTINCT, where the index before it let every slice, mostly NULLs,
    // conflict with nothing — but an upsert only ever adds and overwrites: a
    // slice whose figures have gone since the last run (an agent who no longer
    // answers for anything that day, a category nothing on the day is filed
    // under any more) would keep its old row. Replacing the whole day is also
    // what keeps an older build of this job and this one interchangeable
    // during a deploy: whichever ran last, the day holds one run's rows.
    //
    // A refusal from that key or from the one-dimension CHECK
    // (`metrics_daily_one_dimension`) is not caught per day, unlike a day that
    // fails to reconcile above. `reconcileFailure` has already refused every
    // shape it can name, a second totals row among them, so what reaches a
    // constraint is a shape it cannot: a slice built twice, or a row naming two
    // dimensions. Either refuses only rows this job's own code built wrong, so
    // every day would fail the same way, and the run failing loudly is the
    // point. The day's
    // transaction rolls back whole, marker included, so it keeps the rows the
    // last good run wrote; the newer days before it in the plan are already
    // committed, and the older ones are left as they were.
    //
    // The agent rows are rebuilt the same way and in the same transaction, so a
    // failure halfway cannot leave a day whose ticket figures were recomputed
    // and whose agent figures were not. Safe to destroy because every column is
    // derived: presence intervals, focus intervals and backlog snapshots are
    // append-only and owned elsewhere, which is exactly why the backlog is
    // sampled hourly by its own job rather than counted here.
    await db.transaction(async (tx) => {
      // That the day was computed, in the same transaction as its rows, so a
      // report never reads the day as done before they are there. Written
      // for an empty day too, which is the point: its rows below are none,
      // and "nothing happened" and "not computed yet" read the same from
      // them. First, because its row lock is what puts two rebuilds of one
      // day in order: a second waits here until the first commits, and its
      // deletes then see the first's rows. Without it, both deletes miss the
      // other's inserts, and the second's inserts meet the first's rows in
      // every table's unique key — `metrics_daily_slice_key` among them — so
      // the second run fails on a day it had every right to rebuild. The last
      // to commit leaves its own instant beside its own rows, twice: this code
      // files by category, and the overview reads a day whose two instants
      // differ as one rolled up by code that did not.
      const stamp = { computedAt: startedAt, categoriesComputedAt: startedAt };
      await tx
        .insert(rollupDays)
        .values({ day, ...stamp })
        .onConflictDoUpdate({ target: rollupDays.day, set: stamp });

      await tx.delete(metricsDaily).where(eq(metricsDaily.day, day));
      if (rows.length) await tx.insert(metricsDaily).values(rows);

      await tx.delete(agentMetricsDaily).where(eq(agentMetricsDaily.day, day));
      if (agentRows.length) {
        await tx
          .insert(agentMetricsDaily)
          .values(agentRows.map((row) => ({ ...row, day, computedAt: new Date() })));
      }

      // The subcategory and root-cause tables join the same transaction rather
      // than a job of their own, for the reason at the top of this file: two
      // nightly jobs would be two answers to "which day is this". Rebuilt by
      // delete and insert like the others, and safe to destroy for the same
      // reason — `conversations.created_at` is immutable and
      // `conversation_subcategories.first_seen_at` is append-only, so every column
      // can be recomputed from scratch. The column that would break that is
      // "suggestions still open", which is why it is not there. `resolved_at`
      // is not immutable: a close keeps it (`resolveStamp`), but every resolve
      // stamps it afresh, and a reopen or any move back to Open or Pending
      // clears it. So recomputing a day takes a resolution off it once the
      // ticket has been resolved again or reopened since: it counts on the
      // later resolve's day, or on none while the ticket is open again, and a
      // cause dated by it goes with it or falls back to `root_cause_set_at`.
      // Tickets closed before the close kept it need `restore_resolved_at` run
      // once before any backfill (`docs/PROJECT-STATE.md` §6.98).
      await tx.delete(subcategoryMetricsDaily).where(eq(subcategoryMetricsDaily.day, day));
      if (subcategoryRows.length) await tx.insert(subcategoryMetricsDaily).values(subcategoryRows);

      await tx.delete(rootCauseMetricsDaily).where(eq(rootCauseMetricsDaily.day, day));
      if (causeRows.length) await tx.insert(rootCauseMetricsDaily).values(causeRows);
    });

    // The category rows counted on their own, because a night that writes
    // none on a day that had categorised tickets is the failure no figure
    // beside them would show.
    const categoryRows = rows.filter((row) => row.categoryId).length;
    log.info(
      `${day}: ${rows.length} rows (${categoryRows} by category), ${agentRows.length} agent-day(s), ` +
        `${subcategoryRows.length} subcategory row(s), ${causeRows.length} cause row(s)`,
    );
  }

  log.info(
    `rebuilt ${plan.days.length - inconsistent} of ${plan.days.length} day(s), ` +
      `${plan.days.at(-1)} to ${plan.days[0]}`,
  );

  // Fail the run rather than reporting success over numbers that contradict
  // themselves: a green nightly job is the only signal anyone watches.
  if (inconsistent > 0) {
    throw new Error(
      `[rollup_metrics] ${inconsistent} day(s) failed the totals reconciliation and were not written`,
    );
  }
}
