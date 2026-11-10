import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { resolveLegacyPath } from './legacy-resolve';

/**
 * Where a Freshdesk URL goes, against real Postgres, with the `kb_redirects`
 * rows the importer writes (`writeRedirects` in
 * `worker/handlers/import-freshdesk-kb.ts`): the three bare shapes, pointing
 * at the article in Freshdesk's primary language.
 *
 * Every production row points at an Arabic article (174 rows, 58 articles,
 * 2026-11-08), which is the default locale, so the id lookup and the rows
 * agree there by coincidence. An article first written in English is where
 * they part, and that is the case built here.
 */

withCleanDatabase();

const ID = '154000300001';

async function englishFirst() {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Integrations', slug: 'integrations', locale: 'en' })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Stores', slug: 'stores' })
    .returning({ id: kbFolders.id });
  const rows = await db
    .insert(kbArticles)
    .values(
      [
        { locale: 'en', slug: 'shopify', title: 'Shopify' },
        { locale: 'ar', slug: 'شوبيفاي', title: 'شوبيفاي' },
      ].map((article) => ({
        ...article,
        folderId: folder!.id,
        status: 'published' as const,
        sourceSystem: 'freshdesk' as const,
        externalId: `${ID}:${article.locale}`,
      })),
    )
    .returning({ id: kbArticles.id, locale: kbArticles.locale });
  const english = rows.find((row) => row.locale === 'en')!.id;

  await db
    .insert(kbRedirects)
    .values(
      [
        `/support/solutions/articles/${ID}`,
        `/solutions/articles/${ID}`,
        `/a/solutions/articles/${ID}`,
      ].map((fromPath) => ({ fromPath, articleId: english })),
    );
}

describe('resolveLegacyPath', () => {
  it("sends every shape that names no language to the importer's article, title or not", async () => {
    await englishFirst();

    for (const path of [
      `/support/solutions/articles/${ID}`,
      `/support/solutions/articles/${ID}-shopify-integration`,
      `/a/solutions/articles/${ID}`,
      `/solutions/articles/${ID}`,
    ]) {
      expect(await resolveLegacyPath(path), path).toBe('/en/a/shopify');
    }
  });

  it('keeps the language a portal URL names, with or without a title', async () => {
    await englishFirst();

    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}-x`)).toBe('/ar/a/شوبيفاي');
    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}`)).toBe('/ar/a/شوبيفاي');
  });

  it('answers nothing for an empty path or one nothing here knows', async () => {
    await englishFirst();

    expect(await resolveLegacyPath('')).toBeNull();
    expect(await resolveLegacyPath('/support/solutions/articles/999-missing')).toBeNull();
  });
});
