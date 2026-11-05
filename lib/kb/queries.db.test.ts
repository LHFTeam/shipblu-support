import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  allPublishedArticles,
  folderNeighbours,
  getArticle,
  getCategory,
  getFolder,
  listCategories,
  listTopicFolders,
  recentlyUpdatedArticles,
} from './queries';
import { ANONYMOUS } from './visibility';

/**
 * The help centre's reads that are raw SQL or a filter a static check cannot
 * see: the edit date (`editedAt`, a correlated subquery over the versions), the
 * locale every count and list now filters, and the front page's folder cards.
 */

withCleanDatabase();

const PUBLISHED = new Date('2026-03-01T09:00:00Z');

async function folder(locale: 'ar' | 'en', slug: string): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: slug, slug, locale })
    .returning({ id: kbCategories.id });
  const [row] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: slug, slug })
    .returning({ id: kbFolders.id });
  return row!.id;
}

async function article(
  folderId: string,
  slug: string,
  values: Partial<typeof kbArticles.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId,
      title: slug,
      slug,
      locale: 'en',
      status: 'published',
      publishedAt: PUBLISHED,
      ...values,
    })
    .returning({ id: kbArticles.id });
  return row!.id;
}

/** What `recordArticleView` does: a write the `touch_updated_at` trigger sees. */
async function view(id: string): Promise<void> {
  await db
    .update(kbArticles)
    .set({ viewCount: sql`${kbArticles.viewCount} + 1` })
    .where(eq(kbArticles.id, id));
}

async function edit(id: string, at: Date, version: number): Promise<void> {
  await db.insert(kbArticleVersions).values({
    articleId: id,
    version,
    title: 'before',
    bodyHtml: '<p>before</p>',
    createdAt: at,
  });
}

describe('the edit date', () => {
  it('is the publication date for an article only ever read', async () => {
    const folderId = await folder('en', 'shipping');
    const id = await article(folderId, 'pickups');
    await view(id);

    const [stored] = await db
      .select({ updatedAt: kbArticles.updatedAt })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    // The premise: the view moved the row's own date.
    expect(stored!.updatedAt.getTime()).toBeGreaterThan(PUBLISHED.getTime());

    const read = await getArticle(ANONYMOUS, 'en', 'pickups');
    expect(read?.updatedAt).toEqual(PUBLISHED);
    expect(read?.updatedAt).toBeInstanceOf(Date);
  });

  it('is the newest version once the article is edited', async () => {
    const folderId = await folder('en', 'shipping');
    const id = await article(folderId, 'pickups');
    const first = new Date('2026-04-01T10:00:00Z');
    const second = new Date('2026-05-01T10:00:00Z');
    await edit(id, first, 1);
    await edit(id, second, 2);
    await view(id);

    expect((await getArticle(ANONYMOUS, 'en', 'pickups'))?.updatedAt).toEqual(second);
    expect((await getFolder(ANONYMOUS, 'en', 'shipping', 'shipping'))?.lastUpdatedAt).toEqual(
      second,
    );
    expect((await getCategory(ANONYMOUS, 'en', 'shipping'))?.lastUpdatedAt).toEqual(second);
    expect(await allPublishedArticles()).toEqual([
      { slug: 'pickups', locale: 'en', updatedAt: second },
    ]);
  });

  it('ignores a version cut while the article was still a draft', async () => {
    const folderId = await folder('en', 'shipping');
    const id = await article(folderId, 'pickups');
    await edit(id, new Date('2026-02-01T10:00:00Z'), 1);

    expect((await getArticle(ANONYMOUS, 'en', 'pickups'))?.updatedAt).toEqual(PUBLISHED);
  });

  it('orders "Recently updated" by edits, not by reads', async () => {
    const folderId = await folder('en', 'shipping');
    const edited = await article(folderId, 'edited');
    const read = await article(folderId, 'read');
    await edit(edited, new Date('2026-06-01T10:00:00Z'), 1);
    await view(read);

    const rows = await recentlyUpdatedArticles(ANONYMOUS, 'en');
    expect(rows.map((row) => row.slug)).toEqual(['edited', 'read']);
  });
});

describe('the locale filter', () => {
  it('neither counts nor lists an article filed under the other language', async () => {
    const folderId = await folder('ar', 'shipping');
    await article(folderId, 'arabic', { locale: 'ar' });
    await article(folderId, 'english', { locale: 'en' });

    expect((await listCategories(ANONYMOUS, 'ar')).map((c) => c.articleCount)).toEqual([1]);

    const category = await getCategory(ANONYMOUS, 'ar', 'shipping');
    expect(category?.folders.map((f) => f.articleCount)).toEqual([1]);
    expect(category?.folders.flatMap((f) => f.articles.map((a) => a.slug))).toEqual(['arabic']);

    const listed = await getFolder(ANONYMOUS, 'ar', 'shipping', 'shipping');
    expect(listed?.articles.map((a) => a.slug)).toEqual(['arabic']);
  });
});

describe('folderNeighbours', () => {
  it('answers the next article in order and the rest by helpful votes', async () => {
    const folderId = await folder('en', 'shipping');
    const one = await article(folderId, 'one', { position: 1, helpfulCount: 1 });
    await article(folderId, 'two', { position: 2, helpfulCount: 9 });
    await article(folderId, 'three', { position: 3, helpfulCount: 2 });
    await article(folderId, 'four', { position: 4, helpfulCount: 2 });
    await article(folderId, 'draft', { position: 5, status: 'draft' });

    const { next, related } = await folderNeighbours(ANONYMOUS, 'en', folderId, one);

    expect(next?.slug).toBe('two');
    // Two is already offered as Next; three and four tie and keep the order.
    expect(related.map((a) => a.slug)).toEqual(['three', 'four']);
  });

  it('offers no next article on the last one rather than wrapping round', async () => {
    const folderId = await folder('en', 'shipping');
    await article(folderId, 'one', { position: 1 });
    const last = await article(folderId, 'two', { position: 2 });

    const { next, related } = await folderNeighbours(ANONYMOUS, 'en', folderId, last);

    expect(next).toBeNull();
    expect(related.map((a) => a.slug)).toEqual(['one']);
  });
});

describe('listTopicFolders', () => {
  async function audience(name: string, position: number): Promise<string> {
    const [row] = await db
      .insert(kbCategories)
      .values({ name, slug: name.toLowerCase(), locale: 'en', position })
      .returning({ id: kbCategories.id });
    return row!.id;
  }

  async function subject(
    categoryId: string,
    name: string,
    values: Partial<typeof kbFolders.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(kbFolders)
      .values({ categoryId, name, slug: name.toLowerCase(), ...values })
      .returning({ id: kbFolders.id });
    return row!.id;
  }

  it('groups the folders under their audience, in the folder page order', async () => {
    const partners = await audience('Partners', 0);
    const customers = await audience('Customers', 1);
    const financials = await subject(partners, 'Financials');
    const faqs = await subject(partners, 'FAQs', { description: '  Questions.  ' });
    const tracking = await subject(customers, 'Tracking');

    for (const [position, slug] of ['d', 'a', 'c', 'b'].entries()) {
      await article(financials, `finance-${slug}`, { position });
    }
    await article(faqs, 'faq-one');
    await article(tracking, 'where-is-it');

    const groups = await listTopicFolders(ANONYMOUS, 'en');

    expect(groups.map((group) => [group.name, group.folders.map((f) => f.name)])).toEqual([
      // Folders by position, then name: both are at 0 here, as in production.
      ['Partners', ['FAQs', 'Financials']],
      ['Customers', ['Tracking']],
    ]);

    const finance = groups[0]!.folders[1]!;
    expect(finance.articleCount).toBe(4);
    // The first three in the folder page's own order, by position.
    expect(finance.preview.map((a) => a.slug)).toEqual(['finance-d', 'finance-a', 'finance-c']);

    expect(groups[0]!.folders[0]!.description).toBe('Questions.');
    expect(finance.description).toBeNull();
    expect(groups[0]!.articleCount).toBe(5);
  });

  it('leaves out what a reader may not open, and an audience left with nothing', async () => {
    const partners = await audience('Partners', 0);
    const staff = await audience('Staff', 1);
    const open = await subject(partners, 'Open');
    const internal = await subject(partners, 'Internal', { visibility: 'agents_only' });
    // A folder with nothing in it has no rows, and so no card.
    await subject(partners, 'Empty');
    const handbook = await subject(staff, 'Handbook', { visibility: 'agents_only' });

    await article(open, 'public-one');
    await article(open, 'draft-one', { status: 'draft' });
    await article(open, 'arabic-one', { locale: 'ar' });
    await article(internal, 'runbook');
    await article(handbook, 'rota');

    const groups = await listTopicFolders(ANONYMOUS, 'en');

    expect(groups.map((group) => group.name)).toEqual(['Partners']);
    expect(groups[0]!.folders.map((f) => [f.name, f.articleCount])).toEqual([['Open', 1]]);
    expect(groups[0]!.folders[0]!.preview.map((a) => a.slug)).toEqual(['public-one']);
  });
});
