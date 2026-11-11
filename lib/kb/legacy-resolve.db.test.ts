import { eq } from 'drizzle-orm';
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

const permanent = (to: string) => ({ to, permanent: true });
const temporary = (to: string) => ({ to, permanent: false });

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
  return { english, folder: folder!.id };
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
      expect(await resolveLegacyPath(path), path).toEqual(permanent('/en/a/shopify'));
    }
  });

  it('keeps the language a portal URL names, with or without a title', async () => {
    await englishFirst();

    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}-x`)).toEqual(
      permanent('/ar/a/شوبيفاي'),
    );
    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}`)).toEqual(
      permanent('/ar/a/شوبيفاي'),
    );
  });

  // A redirect to an article nobody can open is a dead link a browser keeps,
  // where another translation would answer. And one to the stand-in is
  // temporary, or the browser and the search index keep it once the article
  // reopens.
  it('answers a closed translation with another, temporarily, the explicit row included', async () => {
    await englishFirst();
    await db
      .update(kbArticles)
      .set({ status: 'archived' })
      .where(eq(kbArticles.externalId, `${ID}:en`));

    // The importer's own rows name the English article, so they step aside.
    expect(await resolveLegacyPath(`/support/solutions/articles/${ID}`)).toEqual(
      temporary('/ar/a/شوبيفاي'),
    );
    // A URL asking for English gets the translation that answers.
    expect(await resolveLegacyPath(`/en/support/solutions/articles/${ID}-x`)).toEqual(
      temporary('/ar/a/شوبيفاي'),
    );
    // A URL asking for the translation that answers keeps its permanence.
    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}`)).toEqual(
      permanent('/ar/a/شوبيفاي'),
    );

    await db.update(kbArticles).set({ status: 'draft' });
    expect(await resolveLegacyPath(`/support/solutions/articles/${ID}`)).toBeNull();
  });

  // Production's internal articles are public on the row and agents-only
  // through their folder: four imported ones, 2026-11-11, each with three
  // redirect rows.
  it('never answers with an article in an agents-only folder, or one marked agents-only', async () => {
    const { folder } = await englishFirst();
    await db.update(kbFolders).set({ visibility: 'agents_only' }).where(eq(kbFolders.id, folder));

    expect(await resolveLegacyPath(`/support/solutions/articles/${ID}`)).toBeNull();
    expect(await resolveLegacyPath(`/ar/support/solutions/articles/${ID}`)).toBeNull();

    await db.update(kbFolders).set({ visibility: 'public' });
    await db
      .update(kbArticles)
      .set({ visibility: 'agents_only' })
      .where(eq(kbArticles.externalId, `${ID}:en`));
    expect(await resolveLegacyPath(`/support/solutions/articles/${ID}`)).toEqual(
      temporary('/ar/a/شوبيفاي'),
    );
  });

  it("falls back to a row's own to_path when the article it names is closed", async () => {
    const { english } = await englishFirst();
    await db
      .insert(kbRedirects)
      .values({ fromPath: '/support/home/shopify', articleId: english, toPath: '/en/c/stores' });

    expect(await resolveLegacyPath('/support/home/shopify')).toEqual(permanent('/en/a/shopify'));

    await db.update(kbArticles).set({ status: 'archived' }).where(eq(kbArticles.id, english));
    expect(await resolveLegacyPath('/support/home/shopify')).toEqual(temporary('/en/c/stores'));
  });

  it('answers nothing for an empty path or one nothing here knows', async () => {
    await englishFirst();

    expect(await resolveLegacyPath('')).toBeNull();
    expect(await resolveLegacyPath('/support/solutions/articles/999-missing')).toBeNull();
  });
});
