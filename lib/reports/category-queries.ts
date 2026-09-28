import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { CAUSE_REQUIRED_AREAS } from '@/lib/categorise/taxonomy';

/**
 * Reading the category and cause rollups.
 *
 * Reads only the rollup tables, exactly as `queries.ts` does, so opening the
 * page never runs an aggregate over every assignment ever made. Labels are
 * joined from the registry so a renamed category reads by its current name,
 * while the rollup keeps the key it was counted under.
 *
 * A category whose key has since been retired still appears — the join is a
 * LEFT JOIN and falls back to the stored key. A report drawn last quarter has to
 * stay readable after somebody tidies the taxonomy, which is the whole reason
 * these tables are keyed on text rather than on a foreign key.
 *
 * ## The window is passed in, never derived here
 *
 * Every function below takes a `Range` of two `YYYY-MM-DD` strings from
 * `rangeIn()` rather than a day count, and none of them mentions `current_date`.
 * That is the fix for a range control that looked broken: `current_date` is the
 * *database's* date, and the database is UTC while the rollup buckets days in
 * the team's zone — so between midnight and 02:00 Cairo the window's edges and
 * the rows' `day` values disagreed about which day it was. Deriving the window
 * once, in the page, also means the dates printed in the header are provably the
 * dates the figures were selected on.
 */

/** An inclusive window over the rollup's `day`, in the reporting zone. */
export type Range = { from: string; to: string };

export type CategoryTotal = {
  categoryKey: string;
  label: string;
  area: string;
  ticketsPrimary: number;
  ticketsAny: number;
  assignedAuto: number;
  assignedSuggested: number;
  assignedManual: number;
};

export async function categoryTotals(range: Range): Promise<CategoryTotal[]> {
  const rows = await db.execute<{
    category_key: string;
    label: string | null;
    area: string;
    tickets_primary: number;
    tickets_any: number;
    assigned_auto: number;
    assigned_suggested: number;
    assigned_manual: number;
  }>(sql`
    select m.category_key,
           tc.label_en as label,
           m.area,
           sum(m.tickets_primary)::int    as tickets_primary,
           sum(m.tickets_any)::int        as tickets_any,
           sum(m.assigned_auto)::int      as assigned_auto,
           sum(m.assigned_suggested)::int as assigned_suggested,
           sum(m.assigned_manual)::int    as assigned_manual
    from category_metrics_daily m
    left join ticket_categories tc on tc.key = m.category_key
    where m.day between ${range.from}::date and ${range.to}::date
    group by m.category_key, tc.label_en, m.area
    order by sum(m.tickets_any) desc, m.category_key
  `);

  return rows.map((row) => ({
    categoryKey: row.category_key,
    label: row.label ?? row.category_key,
    area: row.area,
    ticketsPrimary: row.tickets_primary,
    ticketsAny: row.tickets_any,
    assignedAuto: row.assigned_auto,
    assignedSuggested: row.assigned_suggested,
    assignedManual: row.assigned_manual,
  }));
}

export type AreaTotal = { area: string; ticketsAny: number; ticketsPrimary: number };

/** The twelve-row version of the same thing, which is what fits on a screen. */
export async function areaTotals(range: Range): Promise<AreaTotal[]> {
  const rows = await db.execute<{
    area: string;
    tickets_any: number;
    tickets_primary: number;
  }>(sql`
    select area,
           sum(tickets_any)::int     as tickets_any,
           sum(tickets_primary)::int as tickets_primary
    from category_metrics_daily
    where day between ${range.from}::date and ${range.to}::date
    group by area
    order by sum(tickets_any) desc, area
  `);
  return rows.map((row) => ({
    area: row.area,
    ticketsAny: row.tickets_any,
    ticketsPrimary: row.tickets_primary,
  }));
}

export type ChannelTotal = { channel: string; ticketsPrimary: number; unread: number };

/**
 * Where the demand arrived, and how much of it no rule could read.
 *
 * The channel dimension is in the rollup and was going unread, which left this
 * page unable to answer the one question that decides whether its own numbers
 * mean anything: a lexicon can be good on email and useless on Instagram, and
 * summed across channels that reads as a mediocre overall figure rather than as
 * one channel nobody has written a rule for. It is the "break a count down along
 * the dimension that can fail" rule turned on the detector itself.
 *
 * The two columns count different things on purpose and **must not** be turned
 * into a percentage of one another. `tickets_primary` is a ticket count: exactly
 * one row per ticket carries the primary, so it sums cleanly. `unread` counts
 * tickets carrying `meta.unclassified`, which is per *message* — a ticket whose
 * first message matched a rule and whose second did not appears in both columns,
 * and does so correctly. A ratio of the two would read as "x% unclassified" while
 * being neither a share of tickets nor a share of messages.
 *
 * `tickets_any` is the right column for the fallback for the same reason
 * `tickets_primary` is wrong for it: `meta.unclassified` is never promoted to
 * primary (`applyPrimary` filters it out, because an admission that we could not
 * read a ticket is not a finding), so counting it on `tickets_primary` would
 * report zero forever.
 */
export async function channelTotals(range: Range): Promise<ChannelTotal[]> {
  const rows = await db.execute<{
    channel: string;
    tickets_primary: number;
    unread: number;
  }>(sql`
    select channel::text as channel,
           sum(tickets_primary)::int as tickets_primary,
           coalesce(sum(tickets_any) filter (where category_key = 'meta.unclassified'), 0)::int
             as unread
    from category_metrics_daily
    where day between ${range.from}::date and ${range.to}::date
    group by channel
    order by sum(tickets_primary) desc, channel
  `);
  return rows.map((row) => ({
    channel: row.channel,
    ticketsPrimary: row.tickets_primary,
    unread: row.unread,
  }));
}

export type CauseTotal = {
  causeKey: string;
  label: string;
  owner: string;
  ticketsResolved: number;
};

/**
 * Why tickets happened, and who owns fixing it.
 *
 * The report the feature exists for. Ordered by volume, because the point is to
 * find the cause worth removing rather than to enumerate the taxonomy.
 */
export async function causeTotals(range: Range): Promise<CauseTotal[]> {
  const rows = await db.execute<{
    cause_key: string;
    label: string | null;
    owner: string;
    tickets_resolved: number;
  }>(sql`
    select m.cause_key,
           rc.label_en as label,
           m.owner::text as owner,
           sum(m.tickets_resolved)::int as tickets_resolved
    from root_cause_metrics_daily m
    left join ticket_root_causes rc on rc.key = m.cause_key
    where m.day between ${range.from}::date and ${range.to}::date
    group by m.cause_key, rc.label_en, m.owner
    order by sum(m.tickets_resolved) desc, m.cause_key
  `);

  return rows.map((row) => ({
    causeKey: row.cause_key,
    label: row.label ?? row.cause_key,
    owner: row.owner,
    ticketsResolved: row.tickets_resolved,
  }));
}

export type OwnerTotal = { owner: string; ticketsResolved: number };

/**
 * The single most useful number this system produces: how much of the queue each
 * party caused.
 *
 * `owner` is read from the rollup row rather than joined through the registry,
 * so correcting a cause's owner today does not re-attribute last quarter.
 */
export async function ownerTotals(range: Range): Promise<OwnerTotal[]> {
  const rows = await db.execute<{ owner: string; tickets_resolved: number }>(sql`
    select owner::text as owner, sum(tickets_resolved)::int as tickets_resolved
    from root_cause_metrics_daily
    where day between ${range.from}::date and ${range.to}::date
    group by owner
    order by sum(tickets_resolved) desc, owner
  `);
  return rows.map((row) => ({ owner: row.owner, ticketsResolved: row.tickets_resolved }));
}

/**
 * Where the rolled-up history starts, and which days inside the window have
 * rows.
 *
 * Without this the range control is indistinguishable from a broken one. The
 * rollup recomputes three days a night and there is no category backfill, so
 * every window wider than the history holds the same rows — 7, 30 and 90 all
 * answer identically and the buttons look dead. The page can only say why if it
 * knows where its own data starts and stops, so it asks.
 *
 * Both tables, because they are counted from different timestamps and can
 * legitimately begin on different days: a category comes off `created_at` and a
 * cause off `resolved_at`.
 *
 * `first` has no lower bound, because a day nobody worked has no row. Taken
 * from inside the window it was later than `from` whenever the window opened on
 * a quiet day, and the page said the history begins there — and that a wider
 * range could not reach further back — when it could. `last` and `days` stay
 * inside the window. The overview's `rolledUpDays` answers the same question
 * the same way.
 */
export async function rolledUpRange(range: Range): Promise<{
  first: string | null;
  last: string | null;
  days: number;
}> {
  const rows = await db.execute<{ first: string | null; last: string | null; days: number }>(sql`
    with covered as (
      select day from category_metrics_daily where day <= ${range.to}::date
      union
      select day from root_cause_metrics_daily where day <= ${range.to}::date
    )
    select
      min(day)::text as first,
      (max(day) filter (where day >= ${range.from}::date))::text as last,
      (count(*) filter (where day >= ${range.from}::date))::int as days
    from covered
  `);

  const row = rows[0];
  return { first: row?.first ?? null, last: row?.last ?? null, days: row?.days ?? 0 };
}

/**
 * How many of the tickets that **owed** a cause have one recorded.
 *
 * The honesty check on every number above. A cause report drawn from a third of
 * the tickets is not wrong, but it is not what it looks like either — so the
 * page says the coverage out loud rather than presenting a total that quietly
 * omits whatever nobody filled in.
 *
 * The denominator is the population the resolve gate actually demands a cause
 * from — a ticket whose leading category is in `CAUSE_REQUIRED_AREAS` — and not
 * every ended ticket. Counting price-list questions and integration
 * walkthroughs in the denominator would report a permanent two-thirds gap made
 * almost entirely of tickets that never owed a cause and never will, and a
 * figure that cannot reach 100% is one people stop reading. It shares that list
 * with the gate so the two cannot disagree about who is being measured.
 *
 * Dated by `coalesce(resolved_at, root_cause_set_at)`, matching
 * `computeRootCauseDay`, so the coverage line and the cause table below it
 * describe the same tickets. Bounded at both ends, and the upper bound matters:
 * the window ends at the team's midnight tonight, so a UTC-anchored `>= from`
 * with no `<` would count tomorrow's Cairo-evening resolutions into today's
 * figure while the rollup below it could not.
 *
 * Read live rather than rolled up, because it is a question about the current
 * state of those tickets: somebody can still go back and fill one in, and a
 * rolled-up copy would freeze the gap as it was on the night.
 */
export async function causeCoverage(
  range: Range,
  zone: string,
): Promise<{ withCause: number; total: number }> {
  // `in (…)` built with `sql.join`, and **not** `= any(${CAUSE_REQUIRED_AREAS})`.
  // That reads like working SQL and is the 42809 in PROJECT-STATE §6.46: drizzle
  // interpolates a JS array as one bind parameter per element, so `any($2, $3)`
  // reaches Postgres as a row constructor. `any()` is only correct over an array
  // *column*. This is a page query, so nothing in CI would have caught it.
  const areas = sql.join(
    CAUSE_REQUIRED_AREAS.map((area) => sql`${area}`),
    sql`, `,
  );

  // The window's edges as instants. `resolved_at` is a timestamptz and the
  // window is a pair of dates in the team's zone, so the comparison has to name
  // the zone — casting the date in the database's UTC would move both edges by
  // Cairo's offset, which is the whole bug this file was carrying.
  const rows = await db.execute<{ with_cause: number; total: number }>(sql`
    select count(*) filter (where c.root_cause_id is not null)::int as with_cause,
           count(*)::int as total
    from conversations c
    join conversation_categories cc
      on cc.conversation_id = c.id and cc.is_primary
    where coalesce(c.resolved_at, c.root_cause_set_at)
            >= (${range.from}::date)::timestamp at time zone ${zone}
      and coalesce(c.resolved_at, c.root_cause_set_at)
            < ((${range.to}::date + 1))::timestamp at time zone ${zone}
      and c.deleted_at is null
      and split_part(cc.category_key, '.', 1) in (${areas})
  `);
  const row = rows[0];
  return { withCause: row?.with_cause ?? 0, total: row?.total ?? 0 };
}
