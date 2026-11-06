import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Migrations 0059 and 0060 as a database meets them when it takes both in one
 * deploy: the counters copied off `kb_articles` into `kb_article_stats`, then
 * dropped (`plans/kb-article-stats.md`).
 *
 * The migrated test database is past 0060, so each case puts the three columns
 * back first, inside a transaction it rolls back. Each migration is run from its
 * own file, as Drizzle runs it, so what passes here is what ships. The copy
 * plans in CI's migrate step on an empty table, where it copies nothing; this is
 * the half that needs rows. An article's counts land in its stats row, one with
 * none gets no row, a row already there is never overwritten, and none of it is
 * lost to the drop that follows.
 */

withCleanDatabase();

const migration = (name: string) =>
  readFileSync(new URL(`./migrations/${name}.sql`, import.meta.url), 'utf8');

const COPY = migration('0059_kb_article_stats_copy');
const DROP = migration('0060_kb_articles_drop_counters');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The work is rolled back with this rather than committed. */
class RolledBack extends Error {}

/**
 * Runs `work` on `kb_articles` as it stood between 0057 and 0060, counters on
 * the row, and rolls all of it back.
 */
async function beforeTheDrop(work: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await tx.execute(sql`
        alter table kb_articles
          add column view_count integer not null default 0,
          add column helpful_count integer not null default 0,
          add column unhelpful_count integer not null default 0`);
      await work(tx);
      throw new RolledBack();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
}

/** Drizzle's runner: each statement between the breakpoints, in order. */
async function run(tx: Tx, file: string): Promise<void> {
  for (const statement of file.split('--> statement-breakpoint')) {
    if (statement.trim()) await tx.execute(sql.raw(statement));
  }
}

/** A folder, and in it one article per entry, with its counters on the row. */
async function articles(tx: Tx, counts: Record<string, [number, number, number]>) {
  const [category] = await tx.execute<{ id: string }>(sql`
    insert into kb_categories (name, slug) values ('Shipping', 'shipping') returning id`);
  const [folder] = await tx.execute<{ id: string }>(sql`
    insert into kb_folders (category_id, name, slug)
    values (${category!.id}, 'Pickups', 'pickups') returning id`);
  const ids: Record<string, string> = {};
  for (const [slug, [views, helpful, unhelpful]] of Object.entries(counts)) {
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into kb_articles (folder_id, title, slug, view_count, helpful_count, unhelpful_count)
      values (${folder!.id}, ${slug}, ${slug}, ${views}, ${helpful}, ${unhelpful})
      returning id`);
    ids[slug] = row!.id;
  }
  return ids;
}

/** Every stats row, by its article's slug, as `[views, helpful, unhelpful]`. */
async function stats(tx: Tx) {
  const rows = await tx.execute<{ slug: string; counts: [number, number, number] }>(sql`
    select a.slug, array[s.view_count, s.helpful_count, s.unhelpful_count] as counts
    from kb_article_stats s join kb_articles a on a.id = s.article_id
    order by a.slug`);
  return Object.fromEntries(rows.map((row) => [row.slug, row.counts]));
}

describe('0059_kb_article_stats_copy and 0060_kb_articles_drop_counters', () => {
  it("copies each article's counts, and gives an article with none no row", async () => {
    let copied;
    await beforeTheDrop(async (tx) => {
      await articles(tx, {
        read: [120, 7, 1],
        rated: [0, 2, 0],
        disliked: [0, 0, 3],
        untouched: [0, 0, 0],
      });

      await run(tx, COPY);
      copied = await stats(tx);
    });

    expect(copied).toEqual({ disliked: [0, 0, 3], rated: [0, 2, 0], read: [120, 7, 1] });
  });

  it('never overwrites a stats row already there, and changes nothing run again', async () => {
    let first;
    let second;
    await beforeTheDrop(async (tx) => {
      const ids = await articles(tx, { counted: [3, 3, 3], read: [5, 0, 0] });
      // Production's case: the copy already ran when 0057 deployed, and a
      // view has counted into the row since.
      await tx.execute(sql`
        insert into kb_article_stats (article_id, view_count) values (${ids.counted}, 9)`);

      await run(tx, COPY);
      first = await stats(tx);
      await run(tx, COPY);
      second = await stats(tx);
    });

    expect(first).toEqual({ counted: [9, 0, 0], read: [5, 0, 0] });
    expect(second).toEqual(first);
  });

  it('loses no count to the drop that follows it', async () => {
    let after;
    let columns;
    await beforeTheDrop(async (tx) => {
      await articles(tx, { read: [120, 7, 1] });

      await run(tx, COPY);
      await run(tx, DROP);
      after = await stats(tx);
      columns = await tx.execute(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'kb_articles'
          and column_name in ('view_count', 'helpful_count', 'unhelpful_count')`);
    });

    expect(after).toEqual({ read: [120, 7, 1] });
    expect(columns).toEqual([]);
  });
});
