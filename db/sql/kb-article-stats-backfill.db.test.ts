import { readFileSync } from 'node:fs';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticleStats, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { recordArticleView } from '@/lib/kb/stats';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `011_kb_article_stats_backfill.sql`, run as `db/migrate.ts` runs it: the
 * file's own text, executed, and executed again.
 *
 * The CI replay proves the statement plans and survives a second run on an
 * empty database, where it copies nothing. This is the half that needs rows:
 * that an article's counts land in its stats row, that one with none gets no
 * row, and that a replay — which happens on every deploy until the columns
 * are dropped — never overwrites a row, whoever wrote it.
 */

withCleanDatabase();

const backfill = readFileSync(
  new URL('./011_kb_article_stats_backfill.sql', import.meta.url),
  'utf8',
);

const run = () => db.execute(sql.raw(backfill));

async function folder(): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Shipping', slug: 'shipping' })
    .returning({ id: kbCategories.id });
  const [row] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Pickups', slug: 'pickups' })
    .returning({ id: kbFolders.id });
  return row!.id;
}

/** An article as the release before `kb_article_stats` left it, counts on the row. */
async function article(
  folderId: string,
  slug: string,
  counts: { viewCount?: number; helpfulCount?: number; unhelpfulCount?: number } = {},
): Promise<string> {
  const [row] = await db
    .insert(kbArticles)
    .values({ folderId, title: slug, slug, ...counts })
    .returning({ id: kbArticles.id });
  return row!.id;
}

async function stats() {
  return db
    .select({
      slug: kbArticles.slug,
      viewCount: kbArticleStats.viewCount,
      helpfulCount: kbArticleStats.helpfulCount,
      unhelpfulCount: kbArticleStats.unhelpfulCount,
    })
    .from(kbArticleStats)
    .innerJoin(kbArticles, eq(kbArticles.id, kbArticleStats.articleId))
    .orderBy(asc(kbArticles.slug));
}

describe('011_kb_article_stats_backfill.sql', () => {
  it("copies each article's counts, and gives an article with none no row", async () => {
    const folderId = await folder();
    await article(folderId, 'read', { viewCount: 120, helpfulCount: 7, unhelpfulCount: 1 });
    await article(folderId, 'rated', { helpfulCount: 2 });
    await article(folderId, 'disliked', { unhelpfulCount: 3 });
    await article(folderId, 'untouched');

    await run();

    expect(await stats()).toEqual([
      { slug: 'disliked', viewCount: 0, helpfulCount: 0, unhelpfulCount: 3 },
      { slug: 'rated', viewCount: 0, helpfulCount: 2, unhelpfulCount: 0 },
      { slug: 'read', viewCount: 120, helpfulCount: 7, unhelpfulCount: 1 },
    ]);
  });

  it('changes nothing when replayed', async () => {
    const folderId = await folder();
    await article(folderId, 'read', { viewCount: 120, helpfulCount: 7, unhelpfulCount: 1 });
    await article(folderId, 'untouched');
    await run();
    const first = await stats();

    await run();

    expect(await stats()).toEqual(first);
  });

  it('never overwrites a row written since, by a view or by the old release', async () => {
    const read = await article(await folder(), 'read', { viewCount: 120 });
    await run();

    // The new code counts a view into the stats row; the old release, still
    // serving during the deploy, counts two more onto the column.
    await recordArticleView(read);
    await db
      .update(kbArticles)
      .set({ viewCount: sql`${kbArticles.viewCount} + 2` })
      .where(eq(kbArticles.id, read));

    await run();

    expect(await stats()).toEqual([
      { slug: 'read', viewCount: 121, helpfulCount: 0, unhelpfulCount: 0 },
    ]);
  });
});
