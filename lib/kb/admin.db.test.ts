import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticleStats, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { getArticleForEdit, listArticlesForAdmin, parseArticleFilters } from './admin';

/**
 * The console's article list search. Titles are mostly Arabic and written by
 * several people over years of imports, so the same word turns up spelled more
 * than one way — and a list filter that finds only one spelling reads as "we
 * have no article about that".
 */

withCleanDatabase();

async function article(title: string, slug: string): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: slug, slug })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: slug, slug })
    .returning({ id: kbFolders.id });
  const [row] = await db
    .insert(kbArticles)
    .values({ folderId: folder!.id, title, slug, locale: 'ar' })
    .returning({ id: kbArticles.id });
  return row!.id;
}

describe('listArticlesForAdmin', () => {
  it('finds a title whichever way its Arabic was spelled', async () => {
    const cancel = await article('إلغاء الشحنة', 'cancel');
    await article('تتبع الشحنة', 'track');

    const rows = await listArticlesForAdmin('admin', parseArticleFilters({ q: 'الغاء' }));

    expect(rows.map((row) => row.id)).toEqual([cancel]);
  });

  it('still finds a Latin title and slug by plain substring', async () => {
    const cod = await article('Cash on delivery', 'cash-on-delivery');

    expect(
      (await listArticlesForAdmin('admin', parseArticleFilters({ q: 'on-deliv' }))).map(
        (row) => row.id,
      ),
    ).toEqual([cod]);
  });

  it('treats a query that is only a pasted direction mark as no query', async () => {
    const one = await article('إلغاء الشحنة', 'cancel');
    const two = await article('تتبع الشحنة', 'track');

    const rows = await listArticlesForAdmin('admin', parseArticleFilters({ q: '\u200F' }));

    expect(rows.map((row) => row.id).sort()).toEqual([one, two].sort());
  });
});

describe('what readers did, as the console shows it', () => {
  it('reads the stats row, and an article with none as zero', async () => {
    const read = await article('Cash on delivery', 'cash-on-delivery');
    const unread = await article('Returns', 'returns');
    await db
      .insert(kbArticleStats)
      .values({ articleId: read, viewCount: 31, helpfulCount: 4, unhelpfulCount: 2 });
    // The columns of the same names still on the row, frozen at the move: what
    // is drawn must never be these.
    await db
      .update(kbArticles)
      .set({ viewCount: 900, helpfulCount: 90, unhelpfulCount: 9 })
      .where(eq(kbArticles.id, unread));

    const rows = await listArticlesForAdmin('admin', parseArticleFilters({}));
    const counts = (id: string) => {
      const row = rows.find((candidate) => candidate.id === id)!;
      return [row.viewCount, row.helpfulCount, row.unhelpfulCount];
    };
    expect(counts(read)).toEqual([31, 4, 2]);
    expect(counts(unread)).toEqual([0, 0, 0]);

    expect((await getArticleForEdit(read, 'admin'))?.stats).toEqual({
      views: 31,
      helpful: 4,
      unhelpful: 2,
    });
    const editable = await getArticleForEdit(unread, 'admin');
    expect(editable?.stats).toEqual({ views: 0, helpful: 0, unhelpful: 0 });
    expect(editable).not.toHaveProperty('viewCount');
    expect(editable).not.toHaveProperty('helpfulCount');
    expect(editable).not.toHaveProperty('unhelpfulCount');
  });
});
