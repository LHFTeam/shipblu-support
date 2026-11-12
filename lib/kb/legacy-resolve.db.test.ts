import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { resolveLegacyPath } from './legacy-resolve';
import { getCategory, getFolder } from './queries';
import { ANONYMOUS, type KbViewer } from './visibility';

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
 * ones followed 8 times in the night after the move, each answered with the
 * help centre's 404.
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
      // A public category's id with its last digit gone, which the colon in
      // `<id>:%` keeps from answering for the longer id.
      `/support/solutions/${PARTNERS.slice(0, -1)}`,
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

  // An earlier importer wrote the id bare, with no language, and a re-run
  // adopts such a row rather than writing a second (`matchesExternalId` in
  // the importer), so the lookup matches both forms.
  it('answers a category whose id an earlier importer wrote bare', async () => {
    await category('154000300700', 'ar', 'قديم');
    expect(await resolveLegacyPath('/en/support/solutions/154000300700')).toEqual(
      permanent('/ar/c/قديم'),
    );
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

/**
 * Freshdesk's folder pages, `/support/solutions/folders/<id>`, built as
 * production holds them (2026-11-12): eight public folders, each in Arabic and
 * English under the two public categories, and the employee guide's four, Arabic
 * only and agents-only. Three of the eight are here, two of which share their
 * Arabic slug under different categories. Render's log showed the public ones
 * followed since the domain moved, crawlers and browsers among them, a page of
 * a folder's list (`/page/2`) included, each sent home with a 301.
 */
describe('resolveLegacyPath, for a folder', () => {
  const FAQS = '154000746959';
  const CUSTOMER_FAQS = '154000746963';
  const MYBLU = '154000746964';
  const GUIDE = ['154000745060', '154000745061', '154000745062', '154000745063'];

  type Visibility = 'public' | 'logged_in' | 'agents_only';
  type Article = {
    locale?: string;
    status?: 'draft' | 'published' | 'archived';
    visibility?: Visibility;
  };
  type Category = { id: string; locale: string };

  async function categoryRow(locale: string, slug: string): Promise<Category> {
    const [row] = await db
      .insert(kbCategories)
      .values({ name: slug, slug, locale, sourceSystem: 'freshdesk' })
      .returning({ id: kbCategories.id });
    return { id: row!.id, locale };
  }

  /** One translation of a Freshdesk folder, with an article per entry in `articles`. */
  async function folder(
    category: Category,
    externalId: string,
    slug: string,
    {
      visibility = 'public',
      articles = [{}],
      sourceSystem = 'freshdesk',
    }: {
      visibility?: Visibility;
      articles?: Article[];
      sourceSystem?: 'freshdesk' | 'native';
    } = {},
  ) {
    const [row] = await db
      .insert(kbFolders)
      .values({ categoryId: category.id, name: slug, slug, visibility, sourceSystem, externalId })
      .returning({ id: kbFolders.id });
    for (const [n, article] of articles.entries()) {
      await db.insert(kbArticles).values({
        folderId: row!.id,
        title: `${slug} ${n}`,
        slug: `${externalId.replace(':', '-')}-${n}`,
        locale: article.locale ?? category.locale,
        status: article.status ?? 'published',
        visibility: article.visibility ?? 'public',
      });
    }
    return row!.id;
  }

  /** Production's categories, three of its public folders and the guide's four. */
  async function production() {
    const partners = {
      ar: await categoryRow('ar', 'شركاء-شيب-بلو'),
      en: await categoryRow('en', 'shipblu-partners'),
    };
    const customers = {
      ar: await categoryRow('ar', 'عملاء-شيب-بلو'),
      en: await categoryRow('en', 'shipblu-customers'),
    };
    const guide = await categoryRow('ar', 'دليل-الموظف');

    await folder(partners.ar, `${FAQS}:ar`, 'الأسئلة-الشائعة');
    await folder(partners.en, `${FAQS}:en`, 'faqs');
    await folder(customers.ar, `${CUSTOMER_FAQS}:ar`, 'الأسئلة-الشائعة');
    await folder(customers.en, `${CUSTOMER_FAQS}:en`, 'faqs');
    await folder(customers.ar, `${MYBLU}:ar`, 'دعم-تطبيق-ماي-بلو');
    await folder(customers.en, `${MYBLU}:en`, 'myblu-support');
    for (const [n, id] of GUIDE.entries()) {
      await folder(guide, `${id}:ar`, `فريق-${n}`, { visibility: 'agents_only' });
    }
    return { partners, customers, guide };
  }

  /** The folder's page opens for this reader and lists something on it. */
  async function expectOpens(answer: { to: string } | null, viewer: KbViewer = ANONYMOUS) {
    const [, locale, , category, slug] = answer!.to.split('/');
    const page = await getFolder(viewer, locale as 'ar' | 'en', category!, slug!);
    expect(page?.articles.length, answer!.to).toBeGreaterThan(0);
  }

  async function translationOf(externalId: string) {
    const [row] = await db
      .select({ id: kbFolders.id })
      .from(kbFolders)
      .where(eq(kbFolders.externalId, externalId));
    return row!.id;
  }

  it('sends each shape to the folder’s own page, in the language it names, permanently', async () => {
    await production();

    const answers: [string, string][] = [
      [`/support/solutions/folders/${FAQS}`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      [`/ar/support/solutions/folders/${FAQS}`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      [`/en/support/solutions/folders/${FAQS}`, '/en/c/shipblu-partners/faqs'],
      // The prefixes an article's URL takes, which the folder's has always
      // been read in; the log shows the bare one followed.
      [`/a/solutions/folders/${FAQS}`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      [`/solutions/folders/${FAQS}`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      // A language with a region reads as its language; one the help centre
      // lacks as the default.
      [`/en-US/support/solutions/folders/${FAQS}`, '/en/c/shipblu-partners/faqs'],
      [`/fr/support/solutions/folders/${FAQS}`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      // The same Arabic slug under the other category: the category is read
      // with the folder, so each id lands in its own.
      [`/support/solutions/folders/${CUSTOMER_FAQS}`, '/ar/c/عملاء-شيب-بلو/الأسئلة-الشائعة'],
      [`/en/support/solutions/folders/${CUSTOMER_FAQS}`, '/en/c/shipblu-customers/faqs'],
      [`/en/support/solutions/folders/${MYBLU}`, '/en/c/shipblu-customers/myblu-support'],
      [`/ar/support/solutions/folders/${MYBLU}`, '/ar/c/عملاء-شيب-بلو/دعم-تطبيق-ماي-بلو'],
    ];
    for (const [path, to] of answers) {
      const answer = await resolveLegacyPath(path);
      expect({ path, answer }).toEqual({ path, answer: permanent(to) });
      await expectOpens(answer);
    }
  });

  // The help centre's folder page lists every article at once, so whatever a
  // page of Freshdesk's listed is on it (`freshdeskFolderId`). The first three
  // are shapes the log holds; the last has a trailing slash, which Next
  // answers with its own 308 before the proxy runs, but `?path=` can send.
  it('answers a page of a folder’s list as the folder', async () => {
    await production();

    const answers: [string, string][] = [
      [`/en/support/solutions/folders/${FAQS}/page/2`, '/en/c/shipblu-partners/faqs'],
      [`/en/support/solutions/folders/${FAQS}/page/1`, '/en/c/shipblu-partners/faqs'],
      [`/ar/support/solutions/folders/${FAQS}/page/2`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
      [`/support/solutions/folders/${FAQS}/page/2/`, '/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'],
    ];
    for (const [path, to] of answers) {
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({
        path,
        answer: permanent(to),
      });
    }
    expect(await resolveLegacyPath(`/ar/support/solutions/folders/${GUIDE[0]}/page/2`)).toBeNull();
  });

  // A 301 to the stand-in would be kept by the browser and the search index
  // once the closed translation opens again (`LegacyAnswer`).
  const CLOSINGS: [string, (folder: string) => Promise<unknown>][] = [
    [
      'archiving every article in it',
      (folder) =>
        db.update(kbArticles).set({ status: 'archived' }).where(eq(kbArticles.folderId, folder)),
    ],
    [
      'making it agents-only',
      (folder) =>
        db.update(kbFolders).set({ visibility: 'agents_only' }).where(eq(kbFolders.id, folder)),
    ],
    [
      'leaving only articles in the other language in it',
      (folder) =>
        db.update(kbArticles).set({ locale: 'ar' }).where(eq(kbArticles.folderId, folder)),
    ],
  ];

  for (const [how, close] of CLOSINGS) {
    it(`answers a translation closed by ${how} with another, temporarily`, async () => {
      await production();
      await close(await translationOf(`${FAQS}:en`));

      for (const path of [
        `/en/support/solutions/folders/${FAQS}`,
        `/en/support/solutions/folders/${FAQS}/page/2`,
      ]) {
        const asked = await resolveLegacyPath(path);
        expect({ path, asked }).toEqual({
          path,
          asked: temporary('/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'),
        });
        await expectOpens(asked);
      }
      // The URLs naming the translation that answers keep their permanence.
      for (const path of [
        `/support/solutions/folders/${FAQS}`,
        `/ar/support/solutions/folders/${FAQS}`,
      ]) {
        expect({ path, answer: await resolveLegacyPath(path) }).toEqual({
          path,
          answer: permanent('/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'),
        });
      }
      // The other folders are untouched, the one sharing the Arabic slug too.
      expect(await resolveLegacyPath(`/en/support/solutions/folders/${CUSTOMER_FAQS}`)).toEqual(
        permanent('/en/c/shipblu-customers/faqs'),
      );
    });
  }

  it('takes whichever translation answers when the named and the default one do not', async () => {
    const ID = '154000300400';
    const english = await categoryRow('en', 'integrations');
    await folder(english, `${ID}:en`, 'stores');

    // No Arabic translation at all: English is the answer were every one open.
    for (const path of [
      `/support/solutions/folders/${ID}`,
      `/ar/support/solutions/folders/${ID}`,
    ]) {
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({
        path,
        answer: permanent('/en/c/integrations/stores'),
      });
    }

    // An Arabic one closed for now: English stands in for it.
    const arabic = await categoryRow('ar', 'التكاملات');
    await folder(arabic, `${ID}:ar`, 'المتاجر', { articles: [{ status: 'draft' }] });
    expect(await resolveLegacyPath(`/support/solutions/folders/${ID}`)).toEqual(
      temporary('/en/c/integrations/stores'),
    );
    expect(await resolveLegacyPath(`/en/support/solutions/folders/${ID}`)).toEqual(
      permanent('/en/c/integrations/stores'),
    );

    // Opened, the Arabic one is the answer again, and for good.
    await db.update(kbArticles).set({ status: 'published' });
    expect(await resolveLegacyPath(`/support/solutions/folders/${ID}`)).toEqual(
      permanent('/ar/c/التكاملات/المتاجر'),
    );
  });

  // Their own pages are a 404 for every reader (`getFolder`), and an id nothing
  // was imported under answers the same, so the response says nothing about
  // whether an internal folder exists under the id. Until this change each
  // answered a 301 to the home.
  it('answers nothing for the employee guide’s folders, as for an id nothing was imported under', async () => {
    await production();

    expect(await getFolder(ANONYMOUS, 'ar', 'دليل-الموظف', 'فريق-0')).toBeNull();
    for (const path of [
      ...GUIDE.map((id) => `/support/solutions/folders/${id}`),
      `/ar/support/solutions/folders/${GUIDE[1]}`,
      `/en/support/solutions/folders/${GUIDE[2]}`,
      `/solutions/folders/${GUIDE[3]}`,
      '/support/solutions/folders/154000518595',
      // A public folder's id with its last digit gone: the colon in
      // `<id>:%` is what keeps it from answering for the longer id.
      `/support/solutions/folders/${FAQS.slice(0, -1)}`,
    ]) {
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({ path, answer: null });
    }

    // The folder's own visibility decides, not the id: one opened, and it answers.
    await db
      .update(kbFolders)
      .set({ visibility: 'public' })
      .where(eq(kbFolders.externalId, `${GUIDE[0]}:ar`));
    const opened = await resolveLegacyPath(`/support/solutions/folders/${GUIDE[0]}`);
    expect(opened).toEqual(permanent('/ar/c/دليل-الموظف/فريق-0'));
    await expectOpens(opened);
  });

  it('answers nothing for a folder whose page would hold nothing for any reader', async () => {
    const arabic = await categoryRow('ar', 'مخزن');
    const french = await categoryRow('fr', 'entrepot');
    // Only drafts; only agents-only articles; only articles in another
    // language, which its page does not list; no articles at all; a category
    // in a language the help centre lacks; and a native folder that happens to
    // carry the id.
    await folder(arabic, '154000300501:ar', 'مسودات', { articles: [{ status: 'draft' }] });
    await folder(arabic, '154000300502:ar', 'داخلي', {
      articles: [{ visibility: 'agents_only' }],
    });
    await folder(arabic, '154000300503:ar', 'انجليزي', { articles: [{ locale: 'en' }] });
    await folder(arabic, '154000300504:ar', 'فارغ', { articles: [] });
    await folder(french, '154000300505:fr', 'boutiques');
    await folder(arabic, '154000300506:ar', 'أصلي', { sourceSystem: 'native' });

    for (const id of [
      '154000300501',
      '154000300502',
      '154000300503',
      '154000300504',
      '154000300505',
      '154000300506',
    ]) {
      const path = `/support/solutions/folders/${id}`;
      expect({ path, answer: await resolveLegacyPath(path) }).toEqual({ path, answer: null });
    }

    // `getFolder` opens the empty one, saying there is nothing in it: no page a
    // reader should be sent to for good, as a category with nothing to list is
    // a 404 there.
    const empty = await getFolder(ANONYMOUS, 'ar', 'مخزن', 'فارغ');
    expect(empty?.articles).toEqual([]);
    expect((await getFolder(ANONYMOUS, 'ar', 'مخزن', 'انجليزي'))?.articles).toEqual([]);
  });

  // An earlier importer wrote the id bare, with no language, and a re-run
  // adopts such a row (`matchesExternalId` in the importer). The page's
  // language is its category's, which a bare id cannot give.
  it('answers a folder whose id an earlier importer wrote bare', async () => {
    const arabic = await categoryRow('ar', 'قديم');
    await folder(arabic, '154000300700', 'الشحن');

    for (const path of [
      '/support/solutions/folders/154000300700',
      '/en/support/solutions/folders/154000300700',
    ]) {
      const answer = await resolveLegacyPath(path);
      expect({ path, answer }).toEqual({ path, answer: permanent('/ar/c/قديم/الشحن') });
      await expectOpens(answer);
    }
  });

  // `logged_in` passes, as it does for an article and a category
  // (`someReaderMayOpen`): the page opens for the signed-in customers it names.
  it('answers a folder only signed-in customers can open', async () => {
    const arabic = await categoryRow('ar', 'للعملاء');
    await folder(arabic, '154000300600:ar', 'الحساب', { visibility: 'logged_in' });

    const answer = await resolveLegacyPath('/support/solutions/folders/154000300600');
    expect(answer).toEqual(permanent('/ar/c/للعملاء/الحساب'));
    expect(await getFolder(ANONYMOUS, 'ar', 'للعملاء', 'الحساب')).toBeNull();
    await expectOpens(answer, {
      kind: 'customer',
      contactId: '00000000-0000-0000-0000-000000000001',
      companyId: null,
    });
  });

  // The folder is read with the category it is in now, so a folder moved since
  // the import is not sent to the category it left.
  it('answers a folder moved to another category at the page it has there', async () => {
    const { partners } = await production();
    await db
      .update(kbFolders)
      .set({ categoryId: partners.en.id })
      .where(eq(kbFolders.externalId, `${MYBLU}:en`));

    const answer = await resolveLegacyPath(`/en/support/solutions/folders/${MYBLU}`);
    expect(answer).toEqual(permanent('/en/c/shipblu-partners/myblu-support'));
    await expectOpens(answer);
  });

  it('reads no folder out of an article or a category URL with the same id', async () => {
    await production();
    expect(await resolveLegacyPath(`/support/solutions/articles/${FAQS}`)).toBeNull();
    expect(await resolveLegacyPath(`/support/solutions/${FAQS}`)).toBeNull();
  });

  // A row an admin wrote for the URL answers first, and when the article it
  // names is closed with no `to_path`, the folder stands in for it.
  it('follows a kb_redirects row for the URL, and stands the folder in for a closed one', async () => {
    await production();
    const { english } = await englishFirst();
    const path = `/support/solutions/folders/${FAQS}`;
    await db.insert(kbRedirects).values({ fromPath: path, articleId: english });

    expect(await resolveLegacyPath(path)).toEqual(permanent('/en/a/shopify'));

    await db.update(kbArticles).set({ status: 'archived' }).where(eq(kbArticles.id, english));
    expect(await resolveLegacyPath(path)).toEqual(temporary('/ar/c/شركاء-شيب-بلو/الأسئلة-الشائعة'));
  });
});
