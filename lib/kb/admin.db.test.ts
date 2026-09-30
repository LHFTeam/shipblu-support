import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { listArticlesForAdmin, parseArticleFilters } from './admin';

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
