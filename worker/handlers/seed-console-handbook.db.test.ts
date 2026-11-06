import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { seedConsoleHandbook } from './seed-console-handbook';

/**
 * The handbook seed's promise that a run with nothing to do issues no UPDATE
 * at all, held by `xmin`: the transaction that wrote each row's current
 * version, which any write moves, the trigger or no trigger.
 *
 * `touch_updated_at` stamps an UPDATE that changes nothing on every table,
 * `kb_articles` included since its reader counters were dropped
 * (`plans/kb-article-stats.md`), and `/kb` orders by that date. So the seed's
 * field-by-field comparison is the only thing keeping a re-run from floating
 * the whole handbook to the top of the list (PROJECT-STATE §6.59). CI's
 * "seeds idempotently" step counts articles and versions, which a structural
 * re-assert changes neither of; this is the half that sees the write.
 */

withCleanDatabase();

function job(payload: Record<string, unknown> = {}): ClaimedJob {
  return { id: 'job-1', type: 'seed_console_handbook', payload } as unknown as ClaimedJob;
}

/** Every row the seed owns, by table and external id, as last written. */
async function written() {
  const rows = await db.execute<{ row: string; xmin: string; updated_at: string }>(sql`
    select 'category ' || external_id as row, xmin::text, updated_at::text from kb_categories
    where external_id like 'handbook:%'
    union all
    select 'folder ' || external_id, xmin::text, updated_at::text from kb_folders
    where external_id like 'handbook:%'
    union all
    select 'article ' || external_id, xmin::text, updated_at::text from kb_articles
    where external_id like 'handbook:%'
    order by 1`);
  return Object.fromEntries(
    rows.map((row) => [row.row, { xmin: row.xmin, updatedAt: row.updated_at }]),
  );
}

describe('seed_console_handbook', () => {
  it('writes no row on a run with nothing to do, with overwrite or without', async () => {
    await seedConsoleHandbook(job());
    const before = await written();
    expect(Object.keys(before).filter((row) => row.startsWith('article ')).length).toBeGreaterThan(
      0,
    );

    await seedConsoleHandbook(job());
    expect(await written()).toEqual(before);

    await seedConsoleHandbook(job({ overwrite: true }));
    expect(await written()).toEqual(before);
  });

  it('repairs a misfiled article and writes no other row', async () => {
    await seedConsoleHandbook(job());
    const [target] = await db
      .select({
        id: kbArticles.id,
        externalId: kbArticles.externalId,
        visibility: kbArticles.visibility,
      })
      .from(kbArticles)
      .where(sql`${kbArticles.externalId} like 'handbook:%'`)
      .orderBy(kbArticles.externalId)
      .limit(1);
    await db.update(kbArticles).set({ visibility: 'public' }).where(eq(kbArticles.id, target!.id));
    const before = await written();

    await seedConsoleHandbook(job());
    const after = await written();

    const moved = Object.keys(after).filter((row) => after[row]!.xmin !== before[row]!.xmin);
    expect(moved).toEqual([`article ${target!.externalId}`]);
    const [repaired] = await db
      .select({ visibility: kbArticles.visibility })
      .from(kbArticles)
      .where(eq(kbArticles.id, target!.id));
    expect(repaired!.visibility).toBe(target!.visibility);
  });
});
