import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import type { Locale } from './locale';
import { hybridMatch, hybridRank } from './rank';
import { ANONYMOUS, articleVisibleTo, folderVisibleTo, type KbViewer } from './visibility';

/**
 * Read models for the public knowledge base.
 *
 * Every query that can reach a customer goes through `articleVisibleTo(viewer)`. That
 * is the only place the visibility rule is written down, deliberately: this
 * codebase has `agents_only` and `selected_companies` articles in the same
 * table as public ones, and "I forgot the status filter on one page" is exactly
 * how an internal runbook ends up indexed by Google.
 */

/*
 * The visibility rule lives in `./visibility.ts` and takes a viewer. Every query
 * below threads one through, so all four levels are served rather than only
 * `public` — and a query written without one does not compile.
 */

export type CategorySummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
};

export async function listCategories(viewer: KbViewer, locale: Locale): Promise<CategorySummary[]> {
  const rows = await db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      slug: kbCategories.slug,
      description: kbCategories.description,
      articleCount: sql<number>`count(${kbArticles.id})::int`,
    })
    .from(kbCategories)
    .leftJoin(kbFolders, and(eq(kbFolders.categoryId, kbCategories.id), folderVisibleTo(viewer)))
    .leftJoin(kbArticles, and(eq(kbArticles.folderId, kbFolders.id), articleVisibleTo(viewer)))
    .where(eq(kbCategories.locale, locale))
    .groupBy(kbCategories.id)
    .orderBy(asc(kbCategories.position), asc(kbCategories.name));

  // Categories with nothing published are hidden rather than shown empty: an
  // empty category on a help centre reads as a broken page.
  return rows.filter((row) => row.articleCount > 0);
}

/**
 * The categories, each with the first few article titles inside it.
 *
 * The front page shows those titles rather than only a category name and a
 * count, because a name is a guess at what is inside and three titles are the
 * thing itself. Most visitors arriving at a help centre are looking for one
 * specific answer, and seeing it on the front page saves them the category page
 * entirely.
 *
 * Two queries whatever the number of categories, on the same reasoning as
 * `folderPreviews` below: the whole result is a few dozen rows of title and
 * slug, and the per-category cut in JavaScript keeps this a plain `where … in`
 * rather than a window function.
 */
/** Three titles per category on the front page, matching the folder preview. */
const CATEGORY_PREVIEW_SIZE = 3;

export type CategoryPreview = CategorySummary & { preview: ArticleLink[] };

export async function listCategoryPreviews(
  viewer: KbViewer,
  locale: Locale,
): Promise<CategoryPreview[]> {
  const categories = await listCategories(viewer, locale);
  if (categories.length === 0) return [];

  const rows = await db
    .select({
      categoryId: kbFolders.categoryId,
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(
      and(
        inArray(
          kbFolders.categoryId,
          categories.map((category) => category.id),
        ),
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
      ),
    )
    .orderBy(asc(kbFolders.position), asc(kbArticles.position), asc(kbArticles.title));

  const byCategory = new Map<string, ArticleLink[]>();
  for (const { categoryId, ...article } of rows) {
    const list = byCategory.get(categoryId) ?? [];
    if (list.length < CATEGORY_PREVIEW_SIZE) list.push(article);
    byCategory.set(categoryId, list);
  }

  return categories.map((category) => ({
    ...category,
    preview: byCategory.get(category.id) ?? [],
  }));
}

export type RankedArticle = {
  id: string;
  title: string;
  slug: string;
  categoryName: string;
};

/**
 * The most-read articles in this locale.
 *
 * `view_count` is written by `recordArticleView`, which the article page beacons
 * and which is rate limited — so this is "what people opened", inflated a little
 * by whatever got past the limiter, and never a business metric. It is a good
 * enough ordering for a shortlist on the front page and is not used for anything
 * else.
 *
 * Articles nobody has opened are excluded rather than tie-broken to the bottom.
 * A list headed "most read" whose entries all have zero reads is furniture, and
 * the caller hides the section when this comes back empty — which is exactly
 * what a freshly imported knowledge base should do.
 */
export async function popularArticles(
  viewer: KbViewer,
  locale: Locale,
  limit = 6,
): Promise<RankedArticle[]> {
  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      categoryName: kbCategories.name,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(
      and(
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
        sql`${kbArticles.viewCount} > 0`,
      ),
    )
    .orderBy(desc(kbArticles.viewCount), asc(kbArticles.title))
    .limit(limit);
}

/**
 * The tags the published articles carry most often, as search terms.
 *
 * The front page offers a few one-tap searches, and the honest source for them
 * is a question this system cannot answer: nothing records what visitors type,
 * and adding a search log to fill a row of chips would be collecting customer
 * text to decorate a page. Tags are the nearest true thing — editors write them
 * on the articles as the words a customer would use — and they already feed the
 * search index, so a chip built from one cannot return nothing.
 *
 * Raw SQL because the unnest has no expression in the query builder. The
 * visibility predicates are still the shared ones rather than hand-written
 * copies, which is the part that must not drift; the tables are interpolated
 * unaliased so those predicates resolve against them.
 */
export async function popularTags(viewer: KbViewer, locale: Locale, limit = 4): Promise<string[]> {
  const rows = await db.execute<{ tag: string }>(sql`
    SELECT tag
    FROM ${kbArticles}
    JOIN ${kbFolders} ON ${kbFolders.id} = ${kbArticles.folderId}
    CROSS JOIN LATERAL unnest(${kbArticles.tags}) AS tag
    WHERE ${kbArticles.locale} = ${locale}
      AND ${articleVisibleTo(viewer)}
      AND ${folderVisibleTo(viewer)}
      AND length(btrim(tag)) > 0
    GROUP BY tag
    ORDER BY count(*) DESC, tag ASC
    LIMIT ${limit}
  `);

  return (rows as unknown as { tag: string }[]).map((row) => row.tag);
}

export type DatedArticle = {
  id: string;
  title: string;
  slug: string;
  updatedAt: Date;
};

/**
 * What changed recently.
 *
 * `updated_at` is maintained by the `touch_updated_at` trigger, so it moves on
 * any write to the row — including an editor fixing a typo. That is the right
 * meaning here: the question this list answers is "has the answer I read last
 * month changed", not "what was published".
 */
export async function recentlyUpdatedArticles(
  viewer: KbViewer,
  locale: Locale,
  limit = 6,
): Promise<DatedArticle[]> {
  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      updatedAt: kbArticles.updatedAt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(eq(kbArticles.locale, locale), articleVisibleTo(viewer), folderVisibleTo(viewer)))
    .orderBy(desc(kbArticles.updatedAt), asc(kbArticles.title))
    .limit(limit);
}

/** Just enough of an article to render its title as a link. */
export type ArticleLink = {
  id: string;
  title: string;
  slug: string;
};

/**
 * How many article titles a folder shows before it collapses into "View all".
 *
 * Three, which is the live portal's number too. Enough to tell a customer what
 * kind of thing is in the folder — which is the whole job of the preview — and
 * few enough that a category with eight folders still fits on one screen.
 */
const FOLDER_PREVIEW_SIZE = 3;

export type FolderSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
  /** The first `FOLDER_PREVIEW_SIZE` articles, for the category page. */
  preview: ArticleLink[];
};

export type CategoryDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  folders: FolderSummary[];
};

export async function getCategory(
  viewer: KbViewer,
  locale: Locale,
  slug: string,
): Promise<CategoryDetail | null> {
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
    .leftJoin(kbArticles, and(eq(kbArticles.folderId, kbFolders.id), articleVisibleTo(viewer)))
    .where(and(eq(kbFolders.categoryId, category.id), folderVisibleTo(viewer)))
    .groupBy(kbFolders.id)
    .orderBy(asc(kbFolders.position), asc(kbFolders.name));

  const visible = folders.filter((folder) => folder.articleCount > 0);
  const previews = await folderPreviews(
    viewer,
    visible.map((folder) => folder.id),
  );

  return {
    ...category,
    folders: visible.map((folder) => ({ ...folder, preview: previews.get(folder.id) ?? [] })),
  };
}

/**
 * The first few article titles in each of several folders.
 *
 * One query for every folder on the page rather than one per folder: a category
 * with eight folders is eight round trips otherwise, and the whole result set
 * here is a few dozen rows of title and slug. The per-folder cut is taken in
 * JavaScript, which is what keeps this a plain `where … in` instead of a window
 * function nobody will want to read again.
 */
async function folderPreviews(
  viewer: KbViewer,
  folderIds: string[],
): Promise<Map<string, ArticleLink[]>> {
  const byFolder = new Map<string, ArticleLink[]>();
  if (folderIds.length === 0) return byFolder;

  const rows = await db
    .select({
      folderId: kbArticles.folderId,
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
    })
    .from(kbArticles)
    .where(and(inArray(kbArticles.folderId, folderIds), articleVisibleTo(viewer)))
    .orderBy(asc(kbArticles.position), asc(kbArticles.title));

  for (const { folderId, ...article } of rows) {
    const list = byFolder.get(folderId) ?? [];
    if (list.length < FOLDER_PREVIEW_SIZE) list.push(article);
    byFolder.set(folderId, list);
  }

  return byFolder;
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
  viewer: KbViewer,
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
        folderVisibleTo(viewer),
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
    .where(and(eq(kbArticles.folderId, folder.id), articleVisibleTo(viewer)))
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

export async function getArticle(
  viewer: KbViewer,
  locale: Locale,
  slug: string,
): Promise<ArticleDetail | null> {
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
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * One folder's articles, in the order an editor put them in.
 *
 * The widget's FAQ list. `position` rather than `view_count` because this is the
 * one editorially-curated ordering the schema has: an admin points the widget at
 * a folder and the running order is then whatever the KB editor dragged it into,
 * which is the whole reason for choosing a folder over "most read".
 *
 * `folderVisibleTo` is not decoration here and is the reason this takes a viewer
 * rather than a folder id alone. The folder is named by an admin in a form, and
 * production has four `agents_only` folders whose articles are individually
 * marked `published`/`public` — the staff handbook. Filtering on the article
 * alone would publish it to every page that embeds the widget.
 */
export async function folderArticles(
  viewer: KbViewer,
  folderId: string,
  limit = 6,
): Promise<ArticleSummary[]> {
  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(
      and(eq(kbArticles.folderId, folderId), articleVisibleTo(viewer), folderVisibleTo(viewer)),
    )
    .orderBy(asc(kbArticles.position), asc(kbArticles.title))
    .limit(limit);
}

/** Same folder, excluding the article itself. Cheap and usually relevant. */
export async function relatedArticles(
  viewer: KbViewer,
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
        articleVisibleTo(viewer),
      ),
    )
    .orderBy(desc(kbArticles.helpfulCount), asc(kbArticles.position))
    .limit(limit);
}

/** Locales this article has been translated into, for the language switcher. */
export async function translationsOf(
  viewer: KbViewer,
  translationGroupId: string,
): Promise<{ locale: string; slug: string }[]> {
  return db
    .select({ locale: kbArticles.locale, slug: kbArticles.slug })
    .from(kbArticles)
    .where(and(eq(kbArticles.translationGroupId, translationGroupId), articleVisibleTo(viewer)));
}

export type SearchHit = ArticleSummary & { categorySlug: string; rank: number };

/**
 * Full-text search with a trigram fallback.
 *
 * The matching and ranking themselves live in `./rank.ts`, shared with the
 * agent console's search. What is specific to this function is the viewer: the
 * console sees every published article and decides per row whether it may be
 * linked to a customer, while this one must never return a row the reader is
 * not allowed to see at all.
 */
export async function searchArticles(
  viewer: KbViewer,
  locale: Locale,
  query: string,
  limit = 20,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // Written once and reused for both the projection and the ordering. Ordering
  // by output position instead would have sorted by `title`, which reads as
  // "search is alphabetical" rather than as a bug.
  const rank = hybridRank(trimmed);

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
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
        hybridMatch(trimmed),
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

/**
 * Every article a crawler may index.
 *
 * Takes no viewer, deliberately, and hard-codes the anonymous one. A sitemap is
 * read by Google and by anybody who asks for the URL, so there is no signed-in
 * reader for it to reflect — and a `logged_in` article listed here would be
 * published to the open web by the one file whose whole job is telling crawlers
 * what to fetch. Making the parameter unavailable means it cannot be passed a
 * customer by a caller who was being helpful.
 */
export async function allPublishedArticles(): Promise<
  { slug: string; locale: string; updatedAt: Date }[]
> {
  const viewer = ANONYMOUS;

  return db
    .select({
      slug: kbArticles.slug,
      locale: kbArticles.locale,
      updatedAt: kbArticles.updatedAt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(articleVisibleTo(viewer), folderVisibleTo(viewer)))
    .orderBy(desc(kbArticles.updatedAt));
}
