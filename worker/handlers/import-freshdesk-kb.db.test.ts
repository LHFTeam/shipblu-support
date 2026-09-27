import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import type { FreshdeskArticle, FreshdeskCategory, FreshdeskFolder } from '@/lib/freshdesk/client';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { importFreshdeskKb } from './import-freshdesk-kb';

/**
 * What the Freshdesk import writes today, so moving the steps it shares with
 * the other knowledge-base write paths can be proven to change nothing.
 *
 * Freshdesk is a fake answering the four URL shapes the client asks for: the
 * three primary-language lists, and an item by id with a language code on the
 * end. Anything it was not given is a 404, which is Freshdesk's own answer for
 * "no translation in that language". The primary tree is Arabic, as ShipBlu's
 * is, and serves itself under `ar` so both codes are discovered the way they
 * are against the real account.
 */

withCleanDatabase();

const BASE = 'https://shipblu.freshdesk.com/api/v2';

type Account = {
  categories: FreshdeskCategory[];
  folders: Record<number, FreshdeskFolder[]>;
  articles: Record<number, FreshdeskArticle[]>;
  /** Translations by the path suffix the client asks for, `articles/31/en`. */
  translated: Record<string, unknown>;
  /** Paths answered with a 500, to see what one item's failure does to the rest. */
  broken?: string[];
};

function serve(account: Account) {
  const primary: Record<string, unknown> = {};
  for (const category of account.categories) primary[`categories/${category.id}/ar`] = category;
  for (const article of Object.values(account.articles).flat()) {
    primary[`articles/${article.id}/ar`] = article;
  }

  return stubFetch((url) => {
    if (!url.startsWith(BASE)) throw new Error(`unexpected fetch ${url}`);
    const [path = '', query = ''] = url.slice(`${BASE}/solutions/`.length).split('?');
    const page = Number(new URLSearchParams(query).get('page') ?? '1');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (account.broken?.includes(path)) return new Response('boom', { status: 500 });

    // A list is one short page: the client stops on the first one under a full
    // page, so a second request would mean it had stopped reading that.
    const list = (items: unknown[] | undefined) => json(page === 1 ? (items ?? []) : []);
    if (path === 'categories') return list(account.categories);
    let match = /^categories\/(\d+)\/folders$/.exec(path);
    if (match) return list(account.folders[Number(match[1])]);
    match = /^folders\/(\d+)\/articles$/.exec(path);
    if (match) return list(account.articles[Number(match[1])]);

    const item = account.translated[path] ?? primary[path];
    return item ? json(item) : new Response('{}', { status: 404 });
  });
}

const SHIPPING: FreshdeskCategory = {
  id: 11,
  name: 'الشحن والتوصيل',
  description: 'كل ما يخص الشحن',
};

const TRACKING: FreshdeskFolder = {
  id: 21,
  category_id: 11,
  name: 'تتبع الشحنات',
  description: 'أين الشحنة الآن',
  visibility: 1,
};

const STAFF: FreshdeskFolder = {
  id: 22,
  category_id: 11,
  name: 'إرشادات داخلية',
  visibility: 3,
};

const WHERE: FreshdeskArticle = {
  id: 31,
  folder_id: 21,
  title: 'أين شحنتي؟',
  description:
    '<h1 class="title">أين شحنتي</h1><p style="color:red">تتبع الشحنة من صفحة التتبع.</p>' +
    '<script>alert(1)</script>',
  description_text: 'أين شحنتي تتبع الشحنة من صفحة التتبع.',
  status: 2,
  tags: ['tracking'],
  seo_data: { meta_title: 'تتبع الشحنة' },
  hits: 120,
  thumbs_up: 7,
  thumbs_down: 1,
};

const ADDRESS: FreshdeskArticle = {
  id: 32,
  folder_id: 21,
  title: 'تغيير العنوان',
  description: '<p>غيّر العنوان قبل خروج الشحنة.</p>',
  description_text: 'غيّر العنوان قبل خروج الشحنة.',
  status: 1,
};

const ESCALATE: FreshdeskArticle = {
  id: 33,
  folder_id: 22,
  title: 'تصعيد الشكوى',
  description: '<p>ارفع الشكوى إلى المشرف.</p>',
  description_text: 'ارفع الشكوى إلى المشرف.',
  status: 2,
};

function account(overrides: Partial<Account> = {}): Account {
  return {
    categories: [SHIPPING],
    folders: { 11: [TRACKING, STAFF] },
    articles: { 21: [WHERE, ADDRESS], 22: [ESCALATE] },
    translated: {
      'categories/11/en': { id: 11, name: 'Shipping', description: 'All about shipping' },
      // Visibility 3 here and 1 on the primary: the import keeps the primary's.
      'folders/21/en': { id: 21, category_id: 11, name: 'Tracking', visibility: 3 },
      // Status 1 here and 2 on the primary: the import keeps the primary's.
      'articles/31/en': {
        id: 31,
        folder_id: 21,
        title: 'Where is my parcel?',
        description: '<p>Track it from the <b>tracking</b> page.</p>',
        description_text: 'Track it from the tracking page.',
        status: 1,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('FRESHDESK_DOMAIN', 'https://shipblu.freshdesk.com/');
  vi.stubEnv('FRESHDESK_API_KEY', 'test-key');
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

async function categories() {
  return db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      slug: kbCategories.slug,
      description: kbCategories.description,
      locale: kbCategories.locale,
      translationGroupId: kbCategories.translationGroupId,
      sourceSystem: kbCategories.sourceSystem,
      externalId: kbCategories.externalId,
    })
    .from(kbCategories)
    .orderBy(asc(kbCategories.externalId));
}

async function folders() {
  return db
    .select({
      id: kbFolders.id,
      categoryId: kbFolders.categoryId,
      name: kbFolders.name,
      slug: kbFolders.slug,
      description: kbFolders.description,
      visibility: kbFolders.visibility,
      sourceSystem: kbFolders.sourceSystem,
      externalId: kbFolders.externalId,
    })
    .from(kbFolders)
    .orderBy(asc(kbFolders.externalId));
}

async function articles() {
  return db
    .select({
      id: kbArticles.id,
      folderId: kbArticles.folderId,
      title: kbArticles.title,
      slug: kbArticles.slug,
      bodyHtml: kbArticles.bodyHtml,
      bodyText: kbArticles.bodyText,
      excerpt: kbArticles.excerpt,
      locale: kbArticles.locale,
      translationGroupId: kbArticles.translationGroupId,
      status: kbArticles.status,
      visibility: kbArticles.visibility,
      tags: kbArticles.tags,
      seo: kbArticles.seo,
      viewCount: kbArticles.viewCount,
      helpfulCount: kbArticles.helpfulCount,
      unhelpfulCount: kbArticles.unhelpfulCount,
      sourceSystem: kbArticles.sourceSystem,
      externalId: kbArticles.externalId,
    })
    .from(kbArticles)
    .orderBy(asc(kbArticles.externalId));
}

function byExternalId<T extends { externalId: string | null }>(rows: T[], externalId: string): T {
  const row = rows.find((candidate) => candidate.externalId === externalId);
  if (!row) throw new Error(`no row with external id ${externalId}`);
  return row;
}

describe('importFreshdeskKb', () => {
  it('writes the primary tree and each translation beside it', async () => {
    serve(account());

    await importFreshdeskKb();

    const categoryRows = await categories();
    expect(categoryRows.map((row) => row.externalId)).toEqual(['11:ar', '11:en']);
    const [arCategory, enCategory] = categoryRows;
    expect(arCategory).toMatchObject({
      name: 'الشحن والتوصيل',
      slug: 'الشحن-والتوصيل',
      description: 'كل ما يخص الشحن',
      locale: 'ar',
      sourceSystem: 'freshdesk',
    });
    expect(enCategory).toMatchObject({
      name: 'Shipping',
      slug: 'shipping',
      description: 'All about shipping',
      locale: 'en',
      sourceSystem: 'freshdesk',
      translationGroupId: arCategory!.translationGroupId,
    });

    // The staff folder has no translated article beneath it, so no English copy.
    const folderRows = await folders();
    expect(folderRows.map((row) => row.externalId)).toEqual(['21:ar', '21:en', '22:ar']);
    expect(byExternalId(folderRows, '21:ar')).toMatchObject({
      categoryId: arCategory!.id,
      name: 'تتبع الشحنات',
      slug: 'تتبع-الشحنات',
      description: 'أين الشحنة الآن',
      visibility: 'public',
    });
    expect(byExternalId(folderRows, '21:en')).toMatchObject({
      categoryId: enCategory!.id,
      name: 'Tracking',
      slug: 'tracking',
      description: null,
      visibility: 'public',
    });
    expect(byExternalId(folderRows, '22:ar')).toMatchObject({
      categoryId: arCategory!.id,
      visibility: 'agents_only',
    });

    const articleRows = await articles();
    expect(articleRows.map((row) => row.externalId)).toEqual(['31:ar', '31:en', '32:ar', '33:ar']);

    const where = byExternalId(articleRows, '31:ar');
    expect(where).toEqual({
      id: expect.any(String),
      folderId: byExternalId(folderRows, '21:ar').id,
      title: 'أين شحنتي؟',
      // The Arabic question mark stays: it is not URL syntax, as `?` is, so
      // `slugify` has no reason to strip it.
      slug: 'أين-شحنتي؟',
      // Sanitised, then normalised: the script is gone, and so are the class
      // and the inline colour; the body `h1` has become an `h2`.
      bodyHtml: '<h2>أين شحنتي</h2><p>تتبع الشحنة من صفحة التتبع.</p>',
      bodyText: 'أين شحنتي\n\nتتبع الشحنة من صفحة التتبع.',
      excerpt: 'أين شحنتي تتبع الشحنة من صفحة التتبع.',
      locale: 'ar',
      translationGroupId: expect.any(String),
      status: 'published',
      visibility: 'public',
      tags: ['tracking'],
      seo: { title: 'تتبع الشحنة' },
      viewCount: 120,
      helpfulCount: 7,
      unhelpfulCount: 1,
      sourceSystem: 'freshdesk',
      externalId: '31:ar',
    });

    expect(byExternalId(articleRows, '31:en')).toEqual({
      id: expect.any(String),
      folderId: byExternalId(folderRows, '21:en').id,
      title: 'Where is my parcel?',
      slug: 'where-is-my-parcel',
      bodyHtml: '<p>Track it from the <b>tracking</b> page.</p>',
      bodyText: 'Track it from the tracking page.',
      excerpt: 'Track it from the tracking page.',
      locale: 'en',
      translationGroupId: where.translationGroupId,
      status: 'published',
      visibility: 'public',
      tags: [],
      seo: {},
      viewCount: 0,
      helpfulCount: 0,
      unhelpfulCount: 0,
      sourceSystem: 'freshdesk',
      externalId: '31:en',
    });

    expect(byExternalId(articleRows, '32:ar')).toMatchObject({
      status: 'draft',
      visibility: 'public',
    });
    expect(byExternalId(articleRows, '33:ar')).toMatchObject({
      folderId: byExternalId(folderRows, '22:ar').id,
      visibility: 'public',
    });

    // Three legacy URL shapes per primary-language article, none for the translation.
    const redirects = await db
      .select({ fromPath: kbRedirects.fromPath, articleId: kbRedirects.articleId })
      .from(kbRedirects)
      .orderBy(asc(kbRedirects.fromPath));
    expect(redirects).toHaveLength(9);
    expect(redirects.filter((row) => row.fromPath.endsWith('/31'))).toEqual([
      { fromPath: '/a/solutions/articles/31', articleId: where.id },
      { fromPath: '/solutions/articles/31', articleId: where.id },
      { fromPath: '/support/solutions/articles/31', articleId: where.id },
    ]);
  });

  it('updates in place on a re-run, keeping the slug that is already public', async () => {
    serve(account());
    await importFreshdeskKb();
    const before = await articles();

    serve(
      account({
        articles: {
          21: [{ ...WHERE, title: 'وين الشحنة؟', description: '<p>نص جديد</p>', hits: 150 }],
          22: [ESCALATE],
        },
      }),
    );
    await importFreshdeskKb();

    const after = await articles();
    // An article gone from Freshdesk is left where it is: the import never deletes.
    expect(after.map((row) => row.externalId)).toEqual(['31:ar', '31:en', '32:ar', '33:ar']);
    expect(byExternalId(after, '31:ar')).toMatchObject({
      id: byExternalId(before, '31:ar').id,
      title: 'وين الشحنة؟',
      slug: 'أين-شحنتي؟',
      bodyHtml: '<p>نص جديد</p>',
      bodyText: 'نص جديد',
      excerpt: 'نص جديد',
      viewCount: 150,
      translationGroupId: byExternalId(before, '31:ar').translationGroupId,
    });
    expect(byExternalId(after, '31:en').translationGroupId).toBe(
      byExternalId(before, '31:ar').translationGroupId,
    );
    expect(await categories()).toHaveLength(2);
    expect(await folders()).toHaveLength(3);
  });

  it('adopts and repairs a row an earlier version wrote under the bare id', async () => {
    serve(account());
    await importFreshdeskKb();
    const first = byExternalId(await articles(), '31:ar');

    await db
      .update(kbArticles)
      .set({ externalId: '31', locale: 'en' })
      .where(eq(kbArticles.id, first.id));

    await importFreshdeskKb();

    const repaired = await articles();
    expect(repaired).toHaveLength(4);
    expect(byExternalId(repaired, '31:ar')).toMatchObject({ id: first.id, locale: 'ar' });
  });

  it('leaves locally written content alone, and slugs around it', async () => {
    const [category] = await db
      .insert(kbCategories)
      .values({ name: 'Ours', slug: 'shipping', locale: 'en', externalId: '11:en' })
      .returning({ id: kbCategories.id });
    const [folder] = await db
      .insert(kbFolders)
      .values({ categoryId: category!.id, name: 'Ours', slug: 'ours', externalId: '21:en' })
      .returning({ id: kbFolders.id });
    await db.insert(kbArticles).values({
      folderId: folder!.id,
      title: 'Ours',
      slug: 'where-is-my-parcel',
      locale: 'en',
      bodyHtml: '<p>Written here.</p>',
      externalId: '31:en',
    });

    serve(account());
    await importFreshdeskKb();

    const articleRows = await articles();
    const native = articleRows.filter((row) => row.sourceSystem === 'native');
    expect(native).toEqual([
      expect.objectContaining({ title: 'Ours', slug: 'where-is-my-parcel', externalId: '31:en' }),
    ]);
    const imported = articleRows.find(
      (row) => row.sourceSystem === 'freshdesk' && row.externalId === '31:en',
    );
    expect(imported?.slug).toBe('where-is-my-parcel-2');
    expect(
      (await categories()).find(
        (row) => row.sourceSystem === 'freshdesk' && row.externalId === '11:en',
      )?.slug,
    ).toBe('shipping-2');
  });

  it('writes everything it can, then fails naming what it could not', async () => {
    serve(account({ broken: ['articles/31/en'] }));

    await expect(importFreshdeskKb()).rejects.toThrow('1 item(s) failed to import');

    expect((await articles()).map((row) => row.externalId)).toEqual(['31:ar', '32:ar', '33:ar']);
  });

  it('refuses to start without the credentials, before asking Freshdesk anything', async () => {
    vi.stubEnv('FRESHDESK_API_KEY', '');
    resetEnvCache();
    const fetch = serve(account());

    await expect(importFreshdeskKb()).rejects.toThrow(
      'FRESHDESK_DOMAIN and FRESHDESK_API_KEY must be set',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await categories()).toEqual([]);
  });
});
