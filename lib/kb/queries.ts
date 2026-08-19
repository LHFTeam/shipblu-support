import { and, asc, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import type { Locale } from './locale';

/**
 * Read models for the public knowledge base.
 *
 * Every query that can reach a customer goes through `publiclyVisible()`. That
 * is the only place the visibility rule is written down, deliberately: this
 * codebase has `agents_only` and `selected_companies` articles in the same
 * table as public ones, and "I forgot the status filter on one page" is exactly
 * how an internal runbook ends up indexed by Google.
 */

/**
 * Published *and* public.
 *
 * `logged_in` and `selected_companies` are still not served at all, even though
 * customers can now sign in. Wiring them up means threading the viewer through
 * every query below and getting it right in all of them; until that is done,
 * the honest reading of an unevaluated rule is "deny". Treating it as "allow"
 * is how an internal runbook ends up in Google's index.
 */
function publiclyVisible(): SQL {
  return and(eq(kbArticles.status, 'published'), eq(kbArticles.visibility, 'public'))!;
}

function folderVisible(): SQL {
  return eq(kbFolders.visibility, 'public');
}

export type CategorySummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
};

export async function listCategories(locale: Locale): Promise<CategorySummary[]> {
  const rows = await db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      slug: kbCategories.slug,
      description: kbCategories.description,
      articleCount: sql<number>`count(${kbArticles.id})::int`,
    })
    .from(kbCategories)
    .leftJoin(kbFolders, and(eq(kbFolders.categoryId, kbCategories.id), folderVisible()))
    .leftJoin(kbArticles, and(eq(kbArticles.folderId, kbFolders.id), publiclyVisible()))
    .where(eq(kbCategories.locale, locale))
    .groupBy(kbCategories.id)
    .orderBy(asc(kbCategories.position), asc(kbCategories.name));

  // Categories with nothing published are hidden rather than shown empty: an
  // empty category on a help centre reads as a broken page.
  return rows.filter((row) => row.articleCount > 0);
}

export type FolderSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
};

export type CategoryDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  folders: FolderSummary[];
};

export async function getCategory(locale: Locale, slug: string): Promise<CategoryDetail | null> {
  const categories = await db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      slug: kbCategories.slug,
      description: kbCategories.description,
    })
    .from(kbCategories)
    .where(and(eq(kbCategories.locale, locale), eq(kbCategories.slug, slug)))
    .limit(1);

  const category = categories[0];
  if (!category) return null;

  const folders = await db
    .select({
      id: kbFolders.id,
      name: kbFolders.name,
      slug: kbFolders.slug,
      description: kbFolders.description,
      articleCount: sql<number>`count(${kbArticles.id})::int`,
    })
    .from(kbFolders)
    .leftJoin(kbArticles, and(eq(kbArticles.folderId, kbFolders.id), publiclyVisible()))
    .where(and(eq(kbFolders.categoryId, category.id), folderVisible()))
    .groupBy(kbFolders.id)
    .orderBy(asc(kbFolders.position), asc(kbFolders.name));

  return { ...category, folders: folders.filter((folder) => folder.articleCount > 0) };
}

export type ArticleSummary = {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
};

export type FolderDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  categoryName: string;
  categorySlug: string;
  articles: ArticleSummary[];
};

export async function getFolder(
  locale: Locale,
  categorySlug: string,
  folderSlug: string,
): Promise<FolderDetail | null> {
  const rows = await db
    .select({
      id: kbFolders.id,
      name: kbFolders.name,
      slug: kbFolders.slug,
      description: kbFolders.description,
      categoryName: kbCategories.name,
      categorySlug: kbCategories.slug,
    })
    .from(kbFolders)
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(
      and(
        eq(kbCategories.locale, locale),
        eq(kbCategories.slug, categorySlug),
        eq(kbFolders.slug, folderSlug),
        folderVisible(),
      ),
    )
    .limit(1);

  const folder = rows[0];
  if (!folder) return null;

  const articles = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
    })
    .from(kbArticles)
    .where(and(eq(kbArticles.folderId, folder.id), publiclyVisible()))
    .orderBy(asc(kbArticles.position), asc(kbArticles.title));

  return { ...folder, articles };
}

export type ArticleDetail = {
  id: string;
  title: string;
  slug: string;
  bodyHtml: string;
  excerpt: string | null;
  seo: { title?: string; description?: string };
  updatedAt: Date;
  folderId: string;
  folderName: string;
  folderSlug: string;
  categoryName: string;
  categorySlug: string;
  translationGroupId: string;
};

export async function getArticle(locale: Locale, slug: string): Promise<ArticleDetail | null> {
  const rows = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      bodyHtml: kbArticles.bodyHtml,
      excerpt: kbArticles.excerpt,
      seo: kbArticles.seo,
      updatedAt: kbArticles.updatedAt,
      folderId: kbArticles.folderId,
      folderName: kbFolders.name,
      folderSlug: kbFolders.slug,
      categoryName: kbCategories.name,
      categorySlug: kbCategories.slug,
      translationGroupId: kbArticles.translationGroupId,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(
      and(
        eq(kbArticles.locale, locale),
        eq(kbArticles.slug, slug),
        publiclyVisible(),
        folderVisible(),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/** Same folder, excluding the article itself. Cheap and usually relevant. */
export async function relatedArticles(
  folderId: string,
  excludeArticleId: string,
  limit = 5,
): Promise<ArticleSummary[]> {
  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.folderId, folderId),
        ne(kbArticles.id, excludeArticleId),
        publiclyVisible(),
      ),
    )
    .orderBy(desc(kbArticles.helpfulCount), asc(kbArticles.position))
    .limit(limit);
}

/** Locales this article has been translated into, for the language switcher. */
export async function translationsOf(
  translationGroupId: string,
): Promise<{ locale: string; slug: string }[]> {
  return db
    .select({ locale: kbArticles.locale, slug: kbArticles.slug })
    .from(kbArticles)
    .where(and(eq(kbArticles.translationGroupId, translationGroupId), publiclyVisible()));
}

export type SearchHit = ArticleSummary & { categorySlug: string; rank: number };

/**
 * Full-text search with a trigram fallback.
 *
 * Postgres ships no Arabic text search configuration, so the vector is built
 * with `simple` — which does no stemming at all. That makes exact-ish matching
 * good and morphological matching nonexistent, in both languages. Trigram
 * similarity covers the gap: it is what finds "shippment" and what makes
 * Arabic search work at all, since `simple` will not relate a word to the same
 * word with a prefixed conjunction.
 */
export async function searchArticles(
  locale: Locale,
  query: string,
  limit = 20,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // Written once and reused for both the projection and the ordering. Ordering
  // by output position instead would have sorted by `title`, which reads as
  // "search is alphabetical" rather than as a bug.
  const rank = sql<number>`
    greatest(
      ts_rank(${kbArticles.searchVector}, websearch_to_tsquery('simple', ${trimmed})),
      similarity(${kbArticles.title}, ${trimmed}) * 0.6
    )
  `;

  const rows = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
      categorySlug: kbCategories.slug,
      rank,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(
      and(
        eq(kbArticles.locale, locale),
        publiclyVisible(),
        folderVisible(),
        sql`(
          ${kbArticles.searchVector} @@ websearch_to_tsquery('simple', ${trimmed})
          OR ${kbArticles.title} % ${trimmed}
        )`,
      ),
    )
    .orderBy(desc(rank), asc(kbArticles.title))
    .limit(limit);

  return rows;
}

/**
 * Resolves a legacy Freshdesk path.
 *
 * Looked up on 404 rather than on every request: after cutover almost all
 * traffic uses the new URLs, and putting this in the hot path would add a query
 * to every page load to serve a shrinking minority.
 */
export async function findRedirect(fromPath: string): Promise<string | null> {
  const rows = await db
    .select({
      toPath: kbRedirects.toPath,
      articleSlug: kbArticles.slug,
      articleLocale: kbArticles.locale,
    })
    .from(kbRedirects)
    .leftJoin(kbArticles, eq(kbArticles.id, kbRedirects.articleId))
    .where(eq(kbRedirects.fromPath, fromPath))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.articleSlug) return `/${row.articleLocale}/a/${row.articleSlug}`;
  return row.toPath;
}

/**
 * Fire-and-forget view counter.
 *
 * A plain increment, with no per-visitor deduplication: this drives "most read"
 * ordering for the team, not billing, and the alternative is a visitor table
 * and a cookie on a site that otherwise sets none.
 */
export async function recordArticleView(articleId: string): Promise<void> {
  await db
    .update(kbArticles)
    .set({ viewCount: sql`${kbArticles.viewCount} + 1` })
    .where(eq(kbArticles.id, articleId));
}

/** Every published article, for the sitemap. */
export async function allPublishedArticles(): Promise<
  { slug: string; locale: string; updatedAt: Date }[]
> {
  return db
    .select({
      slug: kbArticles.slug,
      locale: kbArticles.locale,
      updatedAt: kbArticles.updatedAt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(publiclyVisible(), folderVisible()))
    .orderBy(desc(kbArticles.updatedAt));
}
