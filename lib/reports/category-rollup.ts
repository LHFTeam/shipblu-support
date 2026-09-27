import { DateTime } from 'luxon';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import type { categoryMetricsDaily, rootCauseMetricsDaily } from '@/db/schema';
import type { ReportingContext } from './rollup';
import { logger } from '@/lib/log';

const log = logger('rollup_metrics');

/**
 * What tickets were about, and why they happened, for one day.
 *
 * Two functions rather than one because they are counted from different
 * timestamps, and that difference is the design:
 *
 * - A **category** is counted from `conversations.created_at`. It describes
 *   demand: what arrived that day.
 * - A **cause** is counted from `coalesce(resolved_at, root_cause_set_at)`. It
 *   describes what was understood that day. A ticket that arrives in one month
 *   and is worked out in the next belongs to the month somebody worked it out,
 *   because that is when the cause became knowable — counting it on arrival
 *   would put a finding on a day when nobody had it. The coalesce is what
 *   covers a ticket an agent **closed** rather than resolved: `resolved_at` is
 *   written only for the `resolved` status category, so a cause recorded on a
 *   closed ticket was stored and counted by nothing at all. See
 *   `conversations.root_cause_set_at` for why widening `resolved_at` instead
 *   was the wrong repair.
 *
 * The day boundary comes from the reporting timezone, not from UTC, exactly as
 * `computeDay` does it: Cairo observes DST, so a fixed offset would put an hour
 * of every changeover day on the wrong side of midnight.
 *
 * **The bot channel is not excluded here, and that is deliberate.** Every other
 * report calls `readOnlyChannels()`, because averaging a first response that
 * never comes into the figures for the ones that do is meaningless. Nothing in
 * these two tables is an average or a duration — they are counts of labels — and
 * the categoriser never writes on that channel anyway, so nothing from it can
 * reach these rows. Adding the filter would be a guard against something that
 * cannot happen, and would read as though these numbers were comparable with
 * `metrics_daily`, which they are not.
 */

type CategoryRow = typeof categoryMetricsDaily.$inferInsert;
type CauseRow = typeof rootCauseMetricsDaily.$inferInsert;

function dayBounds(day: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(day, { zone });
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/**
 * Category counts for one day.
 *
 * One grouped read rather than a query per category. `is_primary` and the review
 * state are counted with `filter` in the same pass, so the three assignment
 * bands and the two ticket counts all come from one scan of the day's rows.
 *
 * Rejected assignments are excluded from every count. An agent throwing a
 * suggestion out is the system being corrected, not a ticket being about that
 * thing, and counting it would make the driver report measure the lexicon's
 * mistakes alongside the customers' problems.
 *
 * **The three bands partition the remaining rows, and `source` decides first.**
 * The first version of this counted `manual` off `source` and the other two off
 * `review_state`, which left a hole exactly where the interesting case is: an
 * agent confirming a suggestion sets `review_state = 'confirmed'` and leaves
 * `source = 'detected'`, so the row matched no filter and vanished from all
 * three columns. Worse, the rebuild is delete-and-insert over a three-day
 * window, so *yesterday's* correct count was destroyed the moment somebody
 * pressed Confirm today — the retroactive rewrite `db/schema/metrics.ts` warns
 * about, arriving through a column its docstring did not think of.
 *
 * A confirmed detection now counts as **suggested**, which is how it was filed;
 * a human later agreeing does not change that, and it means the number stops
 * depending on how much of the review queue has been worked through.
 */
export async function computeCategoryDay(
  day: string,
  { zone }: ReportingContext,
): Promise<CategoryRow[]> {
  const { start, end } = dayBounds(day, zone);

  const rows = await db.execute<{
    category_key: string;
    area: string;
    channel: string;
    tickets_primary: number;
    tickets_any: number;
    assigned_auto: number;
    assigned_suggested: number;
    assigned_manual: number;
  }>(sql`
    select cc.category_key,
           split_part(cc.category_key, '.', 1) as area,
           c.channel::text as channel,
           count(*) filter (where cc.is_primary)::int as tickets_primary,
           count(*)::int                              as tickets_any,
           count(*) filter (where cc.source <> 'manual' and cc.review_state = 'auto')::int
             as assigned_auto,
           count(*) filter (where cc.source <> 'manual' and cc.review_state <> 'auto')::int
             as assigned_suggested,
           count(*) filter (where cc.source = 'manual')::int
             as assigned_manual
    from conversation_categories cc
    join conversations c on c.id = cc.conversation_id
    where c.created_at >= ${start.toISOString()}
      and c.created_at < ${end.toISOString()}
      and c.deleted_at is null
      and cc.review_state <> 'rejected'
    group by cc.category_key, c.channel
  `);

  return rows.map((row) => {
    // Asserted rather than assumed, for the same reason `reconciles()` exists
    // next door: three `filter` clauses that are meant to partition a set are
    // one edited predicate away from overlapping or leaking, and the result is
    // invisible in the output — a column that is quietly too small reads as a
    // quiet week.
    const banded = row.assigned_auto + row.assigned_suggested + row.assigned_manual;
    if (banded !== row.tickets_any) {
      log.error(
        `${day} ${row.category_key}/${row.channel}: ` +
          `${banded} banded assignments but ${row.tickets_any} rows`,
      );
    }

    return {
      day,
      categoryKey: row.category_key,
      area: row.area,
      channel: row.channel as CategoryRow['channel'],
      ticketsPrimary: row.tickets_primary,
      ticketsAny: row.tickets_any,
      assignedAuto: row.assigned_auto,
      assignedSuggested: row.assigned_suggested,
      assignedManual: row.assigned_manual,
      computedAt: new Date(),
    };
  });
}

/**
 * Root-cause counts for one day, by the day the ticket was resolved.
 *
 * The owner is read from the registry and **written into the row**, so a later
 * correction to a cause's owner does not silently re-attribute history. That is
 * the one denormalisation in these tables and it is worth stating: a report that
 * quietly rewrites last quarter is worse than one that is a little out of date.
 */
export async function computeRootCauseDay(
  day: string,
  { zone }: ReportingContext,
): Promise<CauseRow[]> {
  const { start, end } = dayBounds(day, zone);

  const rows = await db.execute<{
    cause_key: string;
    owner: string;
    channel: string;
    tickets_resolved: number;
  }>(sql`
    select rc.key as cause_key,
           rc.owner::text as owner,
           c.channel::text as channel,
           count(*)::int as tickets_resolved
    from conversations c
    join ticket_root_causes rc on rc.id = c.root_cause_id
    where coalesce(c.resolved_at, c.root_cause_set_at) >= ${start.toISOString()}
      and coalesce(c.resolved_at, c.root_cause_set_at) < ${end.toISOString()}
      and c.deleted_at is null
    group by rc.key, rc.owner, c.channel
  `);

  return rows.map((row) => ({
    day,
    causeKey: row.cause_key,
    owner: row.owner as CauseRow['owner'],
    channel: row.channel as CauseRow['channel'],
    ticketsResolved: row.tickets_resolved,
    computedAt: new Date(),
  }));
}
