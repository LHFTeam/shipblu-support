import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { resolveLegacyPath } from './legacy-resolve';
import { getCategory } from './queries';
import { ANONYMOUS } from './visibility';

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

/**
 * Freshdesk's category pages, `/support/solutions/<id>`, built as production
 * holds them (2026-11-12): two public categories in Arabic and English, and
 * the internal employee guide, Arabic only, whose four folders are agents-only
 * and whose articles are public on the row. Render's log showed the two public
 * ones followed 8 times in one night, while the proxy stood the home in for
 * them.
 */
describe('resolveLegacyPath, for a category', () => {
  const PARTNERS = '154000297679';
  const CUSTOMERS = '154000297680';
  const GUIDE = '154000297102';

  type Article = {
    locale?: string;
    status?: 'draft' | 'published' | 'archived';
    visibility?: 'public' | 'logged_in' | 'agents_only';
  };

  /** One translation of a Freshdesk category, with a folder per entry in `folders`. */
  async function category(
    externalId: string,
    locale: string,
    slug: string,
    folders: { visibility?: 'public' | 'logged_in' | 'agents_only'; articles: Article[] }[] = [
      { articles: [{}] },
    ],
    sourceSystem: 'freshdesk' | 'native' = 'freshdesk',
  ) {
    const [row] = await db
      .insert(kbCategories)
      .values({ name: slug, slug, locale, sourceSystem, externalId })
      .returning({ id: kbCategories.id });
    for (const [index, folder] of folders.entries()) {
      const [created] = await db
        .insert(kbFolders)
        .values({
          categoryId: row!.id,
          name: `folder ${index}`,
          slug: `folder-${index}`,
          visibility: folder.visibility ?? 'public',
        })
        .returning({ id: kbFolders.id });
      for (const [n, article] of folder.articles.entries()) {
        await db.insert(kbArticles).values({
          folderId: created!.id,
          title: `${slug} ${index} ${n}`,
          slug: `${slug}-${index}-${n}`,
          locale: article.locale ?? locale,
          status: article.status ?? 'published',
          visibility: article.visibility ?? 'public',
        });
      }
    }
    return row!.id;
  }

  /** Production's three categories. */
  async function production() {
    await category(`${PARTNERS}:ar`, 'ar', 'شركاء-شيب-بلو');
    await category(`${PARTNERS}:en`, 'en', 'shipblu-partners');
    await category(`${CUSTOMERS}:ar`, 'ar', 'عملاء-شيب-بلو');
    await category(`${CUSTOMERS}:en`, 'en', 'shipblu-customers');
    await category(
      `${GUIDE}:ar`,
      'ar',
      'دليل-الموظف',
      [0, 1, 2, 3].map(() => ({ visibility: 'agents_only' as const, articles: [{}] })),
    );
  }

  /** Each page answered, and that the page itself opens for an anonymous reader. */
  async function expectOpens(answer: { to: string } | null) {
    const [, locale, , slug] = answer!.to.split('/');
    expect(await getCategory(ANONYMOUS, locale as 'ar' | 'en', slug!), answer!.to).not.toBeNull();
  }

  it('sends each shape to the category’s own page, in the language it names, permanently', async () => {
    await production();

    const answers: [string, string][] = [
      [`/support/solutions/${PARTNERS}`, '/ar/c/شركاء-شيب-بلو'],
      [`/support/solutions/${PARTNERS}-shipblu-partners`, '/ar/c/شركاء-شيب-بلو'],
      [`/ar/support/solutions/${PARTNERS}`, '/ar/c/شركاء-شيب-بلو'],
      [`/en/support/solutions/${PARTNERS}`, '/en/c/shipblu-partners'],
      [`/en/support/solutions/${CUSTOMERS}`, '/en/c/shipblu-customers'],
      [`/en/support/solutions/${CUSTOMERS}-shipblu-customers`, '/en/c/shipblu-customers'],
      // A language with a region reads as its language; one the help centre
      // lacks, and a trailing slash with none, as the default.
      [`/en-US/support/solutions/${CUSTOMERS}`, '/en/c/shipblu-customers'],
      [`/fr/support/solutions/${CUSTOMERS}`, '/ar/c/عملاء-شيب-بلو'],
      [`/support/solutions/${CUSTOMERS}/`, '/ar/c/عملاء-شيب-بلو'],
    ];
    for (const [path, to] of answers) {
      const answer = await resolveLegacyPath(path);
      expect({ path, answer }).toEqual({ path, answer: permanent(to) });
      await expectOpens(answer);
    }
  });

  // A 301 to the stand-in would be kept by the browser and the search index
  // once the closed translation opens again (`LegacyAnswer`).
  const CLOSINGS: [string, (category: string) => Promise<unknown>][] = [
    [
      'archiving every article in it',
      (category) =>
        db
          .update(kbArticles)
          .set({ status: 'archived' })
          .where(
            inArray(
              kbArticles.folderId,
              db
                .select({ id: kbFolders.id })
                .from(kbFolders)
                .where(eq(kbFolders.categoryId, category)),
            ),
          ),
    ],
    [
      'making every folder in it agents-only',
      (category) =>
        db
          .update(kbFolders)
          .set({ visibility: 'agents_only' })
          .where(eq(kbFolders.categoryId, category)),
    ],
  ];

  for (const [how, close] of CLOSINGS) {
    it(`answers a translation closed by ${how} with another, temporarily`, async () => {
      await production();
      const [english] = await db
        .select({ id: kbCategories.id })
        .from(kbCategories)
        .where(eq(kbCategories.externalId, `${CUSTOMERS}:en`));
      await close(english!.id);

      const asked = await resolveLegacyPath(`/en/support/solutions/${CUSTOMERS}-shipblu-customers`);
      expect(asked).toEqual(temporary('/ar/c/عملاء-شيب-بلو'));
      await expectOpens(asked);
      // The URLs naming the translation that answers keep their permanence.
      expect(await resolveLegacyPath(`/support/solutions/${CUSTOMERS}`)).toEqual(
        permanent('/ar/c/عملاء-شيب-بلو'),
      );
      expect(await resolveLegacyPath(`/ar/support/solutions/${CUSTOMERS}`)).toEqual(
        permanent('/ar/c/عملاء-شيب-بلو'),
      );
      // The other category is untouched.
      expect(await resolveLegacyPath(`/en/support/solutions/${PARTNERS}`)).toEqual(
        permanent('/en/c/shipblu-partners'),
      );
    });
  }

  it('takes whichever translation answers when the named and the default one do not', async () => {
    const ID = '154000300100';
    await category(`${ID}:en`, 'en', 'integrations');

    // No Arabic translation at all: English is the answer were every one open.
    for (const path of [`/support/solutions/${ID}`, `/ar/support/solutions/${ID}`]) {
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({
        path,
        answer: permanent('/en/c/integrations'),
      });
    }

    // An Arabic one closed for now: English stands in for it.
    await category(`${ID}:ar`, 'ar', 'التكاملات', [{ articles: [{ status: 'draft' }] }]);
    expect(await resolveLegacyPath(`/support/solutions/${ID}`)).toEqual(
      temporary('/en/c/integrations'),
    );
    expect(await resolveLegacyPath(`/en/support/solutions/${ID}`)).toEqual(
      permanent('/en/c/integrations'),
    );
  });

  // Its own page is a 404 for every reader (`getCategory`), and an id nothing
  // was imported as answers the same, so the response says nothing about
  // whether an internal category exists under the id.
  it('answers nothing for the internal employee guide, as for an id nothing was imported as', async () => {
    await production();

    expect(await getCategory(ANONYMOUS, 'ar', 'دليل-الموظف')).toBeNull();
    for (const path of [
      `/support/solutions/${GUIDE}`,
      `/ar/support/solutions/${GUIDE}`,
      `/en/support/solutions/${GUIDE}-employee-guide`,
      '/support/solutions/154000999999',
    ]) {
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({ path, answer: null });
    }

    // What is inside decides, not the id: one folder opened, and it answers.
    const [folder] = await db
      .select({ id: kbFolders.id })
      .from(kbFolders)
      .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
      .where(eq(kbCategories.externalId, `${GUIDE}:ar`))
      .limit(1);
    await db.update(kbFolders).set({ visibility: 'public' }).where(eq(kbFolders.id, folder!.id));
    expect(await resolveLegacyPath(`/support/solutions/${GUIDE}`)).toEqual(
      permanent('/ar/c/دليل-الموظف'),
    );
  });

  it('answers nothing for a category whose page would 404 for every reader', async () => {
    // Only drafts; only agents-only articles; only articles in another
    // language, which its page does not list; a locale the help centre lacks;
    // and a native category that happens to carry the id.
    await category('154000300201:ar', 'ar', 'مسودات', [{ articles: [{ status: 'draft' }] }]);
    await category('154000300202:ar', 'ar', 'داخلي', [
      { articles: [{ visibility: 'agents_only' }] },
    ]);
    await category('154000300203:ar', 'ar', 'مخزن', [{ articles: [{ locale: 'en' }] }]);
    await category('154000300204:fr', 'fr', 'entrepot');
    await category('154000300205:ar', 'ar', 'أصلي', undefined, 'native');

    for (const id of [
      '154000300201',
      '154000300202',
      '154000300203',
      '154000300204',
      '154000300205',
    ]) {
      const path = `/support/solutions/${id}`;
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({ path, answer: null });
    }
    expect(await getCategory(ANONYMOUS, 'ar', 'مخزن')).toBeNull();
  });

  // `logged_in` passes, as it does for an article (`someReaderMayOpen`): the
  // page opens for the signed-in customers it names.
  it('answers a category only signed-in customers can open', async () => {
    await category('154000300300:ar', 'ar', 'للعملاء', [
      { visibility: 'logged_in', articles: [{}] },
    ]);
    expect(await resolveLegacyPath('/support/solutions/154000300300')).toEqual(
      permanent('/ar/c/للعملاء'),
    );
  });

  it('reads no category out of an article or a folder URL with the same id', async () => {
    await production();
    expect(await resolveLegacyPath(`/support/solutions/articles/${PARTNERS}`)).toBeNull();
    expect(await resolveLegacyPath(`/support/solutions/folders/${PARTNERS}`)).toBeNull();
  });

  // A row an admin wrote for the URL answers first, and when the article it
  // names is closed with no `to_path`, the category stands in for it.
  it('follows a kb_redirects row for the URL, and stands the category in for a closed one', async () => {
    await production();
    const { english } = await englishFirst();
    const path = `/support/solutions/${PARTNERS}`;
    await db.insert(kbRedirects).values({ fromPath: path, articleId: english });

    expect(await resolveLegacyPath(path)).toEqual(permanent('/en/a/shopify'));

    await db.update(kbArticles).set({ status: 'archived' }).where(eq(kbArticles.id, english));
    expect(await resolveLegacyPath(path)).toEqual(temporary('/ar/c/شركاء-شيب-بلو'));
  });
});
