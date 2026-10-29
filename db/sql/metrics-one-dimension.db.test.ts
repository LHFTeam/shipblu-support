import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { groups, metricsDaily, ticketCategories } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The two halves of "a metrics_daily row is one slice": the CHECK
 * `metrics_daily_one_dimension` from db/sql/003 (no row names two dimensions)
 * and the key `metrics_daily_slice_key` from the schema (no slice is written
 * twice for a day, NULLs compared as equal). Both hold for any writer, a
 * hand-run repair included; the rollup's own tests hold `rollup_metrics` to
 * them from the other side.
 */

withCleanDatabase();

const DAY = '2026-10-13';

async function ids() {
  const [group] = await db.select({ id: groups.id }).from(groups).where(eq(groups.name, 'Support'));
  const [category] = await db
    .select({ id: ticketCategories.id })
    .from(ticketCategories)
    .where(eq(ticketCategories.key, 'sales'));
  return { groupId: group!.id, categoryId: category!.id };
}

describe('metrics_daily_one_dimension', () => {
  it('is on the table, as the replay of db/sql left it', async () => {
    const rows = await db.execute<{ definition: string }>(sql`
      select pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conname = 'metrics_daily_one_dimension'
         and conrelid = 'public.metrics_daily'::regclass`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definition).toMatch(/num_nonnulls\(group_id, agent_id, channel, category_id\)/);
  });

  it('takes the totals and each single-dimension slice', async () => {
    const { groupId, categoryId } = await ids();
    await db
      .insert(metricsDaily)
      .values([
        { day: DAY },
        { day: DAY, groupId },
        { day: DAY, channel: 'email' },
        { day: DAY, categoryId },
      ]);
    const rows = await db.select({ id: metricsDaily.id }).from(metricsDaily);
    expect(rows).toHaveLength(4);
  });

  it('refuses a row that names two dimensions', async () => {
    const { groupId, categoryId } = await ids();
    await expect(
      db.insert(metricsDaily).values({ day: DAY, groupId, categoryId }),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'metrics_daily_one_dimension' },
    });
    await expect(
      db.insert(metricsDaily).values({ day: DAY, channel: 'email', categoryId }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('metrics_daily_slice_key', () => {
  it('refuses a second totals row for a day, and a second row of one category', async () => {
    const { categoryId } = await ids();
    await db.insert(metricsDaily).values([{ day: DAY }, { day: DAY, categoryId }]);

    await expect(db.insert(metricsDaily).values({ day: DAY })).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'metrics_daily_slice_key' },
    });
    await expect(db.insert(metricsDaily).values({ day: DAY, categoryId })).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'metrics_daily_slice_key' },
    });
  });

  it('takes the same slice on another day', async () => {
    const { categoryId } = await ids();
    await db.insert(metricsDaily).values([
      { day: DAY, categoryId },
      { day: '2026-10-14', categoryId },
    ]);
    const rows = await db.select({ id: metricsDaily.id }).from(metricsDaily);
    expect(rows).toHaveLength(2);
  });
});
