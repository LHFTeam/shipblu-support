import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

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
 */

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

export async function categoryTotals(days: number): Promise<CategoryTotal[]> {
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
    where m.day >= current_date - ${days}::int
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

export type AreaTotal = { area: string; ticketsAny: number };

/** The twelve-row version of the same thing, which is what fits on a screen. */
export async function areaTotals(days: number): Promise<AreaTotal[]> {
  const rows = await db.execute<{ area: string; tickets_any: number }>(sql`
    select area, sum(tickets_any)::int as tickets_any
    from category_metrics_daily
    where day >= current_date - ${days}::int
    group by area
    order by sum(tickets_any) desc
  `);
  return rows.map((row) => ({ area: row.area, ticketsAny: row.tickets_any }));
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
export async function causeTotals(days: number): Promise<CauseTotal[]> {
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
    where m.day >= current_date - ${days}::int
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
export async function ownerTotals(days: number): Promise<OwnerTotal[]> {
  const rows = await db.execute<{ owner: string; tickets_resolved: number }>(sql`
    select owner::text as owner, sum(tickets_resolved)::int as tickets_resolved
    from root_cause_metrics_daily
    where day >= current_date - ${days}::int
    group by owner
    order by sum(tickets_resolved) desc
  `);
  return rows.map((row) => ({ owner: row.owner, ticketsResolved: row.tickets_resolved }));
}

/**
 * How many resolved tickets never had a cause recorded.
 *
 * The honesty check on every number above. A cause report drawn from a third of
 * the tickets is not wrong, but it is not what it looks like either — so the
 * page says the coverage out loud rather than presenting a total that quietly
 * omits whatever nobody filled in.
 *
 * Read live rather than rolled up, because it is a question about the current
 * state of those tickets: somebody can still go back and fill one in, and a
 * rolled-up copy would freeze the gap as it was on the night.
 */
export async function causeCoverage(days: number): Promise<{ withCause: number; total: number }> {
  const rows = await db.execute<{ with_cause: number; total: number }>(sql`
    select count(*) filter (where root_cause_id is not null)::int as with_cause,
           count(*)::int as total
    from conversations
    where resolved_at >= current_date - ${days}::int
      and deleted_at is null
  `);
  const row = rows[0];
  return { withCause: row?.with_cause ?? 0, total: row?.total ?? 0 };
}
