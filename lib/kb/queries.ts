import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
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

/**
 * When an article's content last changed — what every "Last updated" on the
 * help centre means, and what the sitemap's `lastmod` and "Recently updated"
 * are ordered by.
 *
 * Not `kb_articles.updated_at`. That column once moved on every view, because
 * `recordArticleView` writes the row and the `touch_updated_at` trigger stamped
 * every write, so a busy article told each customer it was revised today
 * (PROJECT-STATE §6.51). The trigger now leaves the date alone when only a
 * reader's counter changes, but the column still moves for a change of folder,
 * status, visibility or tags, none of which is a revision a customer reads, and
 * on an imported article it starts at the import, not at the last edit. A
 * version is cut only when the title or the body changes (`cutArticleVersion`),
 * so the newest one is the last edit; an article never edited since it went up
 * is as old as its publication, and a draft that never had one as its row.
 * `greatest` because a version cut while the article was still a draft is older
 * than the day it was published, and nulls drop out of it.
 *
 * Mapped through a timestamp column so it arrives as a `Date`, as the columns
 * it stands in for did.
 *
 * The subquery spells its correlation out by table name rather than
 * interpolating the columns. Drizzle leaves a column unqualified in a select
 * with no join, so `${kbArticles.id}` inside the subquery came out as a bare
 * `"id"`, which Postgres binds to the nearest scope, `kb_article_versions.id`:
 * no version ever matched, and a folder page dated every article by its
 * publication while the article page, which joins, dated it by its last edit
 * (`queries.db.test.ts`).
 */
const editedAt =
  sql<Date>`coalesce(greatest((select max(v.created_at) from ${kbArticleVersions} v where v.article_id = ${kbArticles}.id), ${kbArticles.publishedAt}), ${kbArticles.createdAt})`.mapWith(
    kbArticles.updatedAt,
  );

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
    .leftJoin(
      kbArticles,
      and(
        eq(kbArticles.folderId, kbFolders.id),
        // Every count and list on the help centre filters the article's own
        // locale, as `getArticle` does. A folder inherits its category's
        // language and the Freshdesk importer does not enforce that an article
        // matches, so without it a mis-filed English row is counted, listed and
        // linked on an Arabic page whose link then 404s.
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
      ),
    )
    .where(eq(kbCategories.locale, locale))
    .groupBy(kbCategories.id)
    .orderBy(asc(kbCategories.position), asc(kbCategories.name));

  // Categories with nothing published are hidden rather than shown empty: an
  // empty category on a help centre reads as a broken page.
  return rows.filter((row) => row.articleCount > 0);
}

/**
 * The front page's topics: each audience with its folders, and the first few
 * article titles inside each folder.
 *
 * The design draws "Browse by topic" as one card per subject — Getting started,
 * Shipments & tracking, Payments & settlement. Production's top level is two
 * audiences rather than subjects ("ShipBlu Partners", "ShipBlu Customers"), and
 * the subjects are the folders under them: Financials, Integrations, Shipping
 * Services. So a card is a folder, and the audiences are the groups the cards
 * sit in.
 *
 * Each card lists titles rather than only a name and a count, because a name is
 * a guess at what is inside and three titles are the thing itself: a visitor
 * who spots the answer they came for skips the folder page entirely.
 *
 * One query beyond the categories, whatever the number of folders: the whole
 * result is a few dozen rows of title and slug, and the per-folder cut in
 * JavaScript keeps it a plain `where … in` rather than a window function. A
 * folder with nothing the reader may open in this locale has no rows and so no
 * card, and an audience left with no card has no group.
 */
const FOLDER_PREVIEW_SIZE = 3;

export type TopicFolder = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
  preview: ArticleLink[];
};

export type TopicGroup = CategorySummary & { folders: TopicFolder[] };

export async function listTopicFolders(viewer: KbViewer, locale: Locale): Promise<TopicGroup[]> {
  const categories = await listCategories(viewer, locale);
  if (categories.length === 0) return [];

  const rows = await db
    .select({
      categoryId: kbFolders.categoryId,
      folderId: kbFolders.id,
      folderName: kbFolders.name,
      folderSlug: kbFolders.slug,
      folderDescription: kbFolders.description,
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
        // The article's own locale, as every list here filters it: a folder
        // inherits its category's language, and a mis-filed row would be
        // counted on this card and linked to a 404.
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
      ),
    )
    // The folder page's own order, folder by folder, so the card's three
    // titles are the first three a reader meets on the page it links to.
    .orderBy(
      asc(kbFolders.position),
      asc(kbFolders.name),
      asc(kbArticles.position),
      asc(kbArticles.title),
    );

  const folders = new Map<string, TopicFolder>();
  const byCategory = new Map<string, TopicFolder[]>();
  for (const row of rows) {
    let folder = folders.get(row.folderId);
    if (!folder) {
      folder = {
        id: row.folderId,
        name: row.folderName,
        slug: row.folderSlug,
        description: row.folderDescription?.trim() || null,
        articleCount: 0,
        preview: [],
      };
      folders.set(row.folderId, folder);
      byCategory.set(row.categoryId, [...(byCategory.get(row.categoryId) ?? []), folder]);
    }
    folder.articleCount += 1;
    if (folder.preview.length < FOLDER_PREVIEW_SIZE) {
      folder.preview.push({ id: row.id, title: row.title, slug: row.slug });
    }
  }

  return categories
    .map((category) => ({ ...category, folders: byCategory.get(category.id) ?? [] }))
    .filter((group) => group.folders.length > 0);
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
 * What changed recently: the question this list answers is "has the answer I
 * read last month changed", not "what was published", so it is ordered by the
 * last edit to the content (`editedAt`) — an editor fixing a typo counts, a
 * reader opening the page does not.
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
      updatedAt: editedAt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(eq(kbArticles.locale, locale), articleVisibleTo(viewer), folderVisibleTo(viewer)))
    .orderBy(desc(editedAt), asc(kbArticles.title))
    .limit(limit);
}

/** Just enough of an article to render its title as a link. */
export type ArticleLink = {
  id: string;
  title: string;
  slug: string;
};

export type FolderSummary = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  articleCount: number;
  /**
   * Every article in the folder the viewer may read, in the editor's order.
   *
   * All of them, not a preview: the category page lists each folder as a
   * section of article rows, title and excerpt, the way the help-centre design
   * draws a topic. Production's largest folder holds fifteen, and a list a
   * reader scans beats a "View all" they have to press to find out.
   */
  articles: ArticleSummary[];
};

export type CategoryDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  folders: FolderSummary[];
  /** The newest edit to anything listed (`editedAt`), for "Last updated" in the header. */
  lastUpdatedAt: Date | null;
};

/**
 * One category and the folders inside it that this viewer may open.
 *
 * Null when none of them are, which is what makes the page 404 rather than
 * render — the same cut `listCategories` takes for the front page, and for a
 * second reason as well as "an empty category reads as a broken page". A
 * category has no visibility column of its own, so the only thing keeping an
 * internal one off the public help centre is this: the console's handbook lives
 * in a category whose every folder is `agents_only`, and served as a 200 that
 * page published the category's Arabic name as its `<title>` and its
 * description as the meta description, to anybody who guessed the slug and to
 * anything that crawled it. The articles were never reachable; the page around
 * them was.
 */
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
    .leftJoin(
      kbArticles,
      and(
        eq(kbArticles.folderId, kbFolders.id),
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
      ),
    )
    .where(and(eq(kbFolders.categoryId, category.id), folderVisibleTo(viewer)))
    .groupBy(kbFolders.id)
    .orderBy(asc(kbFolders.position), asc(kbFolders.name));

  const visible = folders.filter((folder) => folder.articleCount > 0);
  if (visible.length === 0) return null;

  const { byFolder, lastUpdatedAt } = await folderListings(
    viewer,
    locale,
    visible.map((folder) => folder.id),
  );

  return {
    ...category,
    folders: visible.map((folder) => ({ ...folder, articles: byFolder.get(folder.id) ?? [] })),
    lastUpdatedAt,
  };
}

/**
 * Every readable article in each of several folders, and the newest edit among
 * them.
 *
 * One query for every folder on the page rather than one per folder: a category
 * with eight folders is eight round trips otherwise, and the whole result set
 * here is a few dozen rows of title, slug and excerpt. The split by folder is
 * taken in JavaScript, which is what keeps this a plain `where … in`.
 */
async function folderListings(
  viewer: KbViewer,
  locale: Locale,
  folderIds: string[],
): Promise<{ byFolder: Map<string, ArticleSummary[]>; lastUpdatedAt: Date | null }> {
  const byFolder = new Map<string, ArticleSummary[]>();
  if (folderIds.length === 0) return { byFolder, lastUpdatedAt: null };

  const rows = await db
    .select({
      folderId: kbArticles.folderId,
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
      updatedAt: editedAt,
    })
    .from(kbArticles)
    .where(
      and(
        inArray(kbArticles.folderId, folderIds),
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
      ),
    )
    .orderBy(asc(kbArticles.position), asc(kbArticles.title));

  let lastUpdatedAt: Date | null = null;
  for (const { folderId, updatedAt, ...article } of rows) {
    const list = byFolder.get(folderId) ?? [];
    list.push(article);
    byFolder.set(folderId, list);
    if (!lastUpdatedAt || updatedAt > lastUpdatedAt) lastUpdatedAt = updatedAt;
  }

  return { byFolder, lastUpdatedAt };
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
  /** The newest edit to any article listed (`editedAt`), for "Last updated" in the header. */
  lastUpdatedAt: Date | null;
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

  const listed = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
      updatedAt: editedAt,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.folderId, folder.id),
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
      ),
    )
    .orderBy(asc(kbArticles.position), asc(kbArticles.title));

  let lastUpdatedAt: Date | null = null;
  const articles = listed.map(({ updatedAt, ...article }) => {
    if (!lastUpdatedAt || updatedAt > lastUpdatedAt) lastUpdatedAt = updatedAt;
    return article;
  });

  return { ...folder, articles, lastUpdatedAt };
}

export type ArticleDetail = {
  id: string;
  title: string;
  slug: string;
  bodyHtml: string;
  /** The body as plain text, which the excerpt was cut from (`articleBody`). */
  bodyText: string;
  excerpt: string | null;
  seo: { title?: string; description?: string };
  /** The last edit to the content (`editedAt`), not the row's `updated_at`. */
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
      bodyText: kbArticles.bodyText,
      excerpt: kbArticles.excerpt,
      seo: kbArticles.seo,
      updatedAt: editedAt,
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
  locale: Locale,
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
      and(
        eq(kbArticles.folderId, folderId),
        // Carried even though the folder implies it. A folder has no locale of
        // its own, it inherits its category's, and only one console action
        // enforces that an article matches — the Freshdesk importer does not. A
        // mis-filed row would otherwise put an English FAQ in the Arabic widget,
        // where every tap 404s because `getArticle` *does* filter on locale.
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
      ),
    )
    .orderBy(asc(kbArticles.position), asc(kbArticles.title))
    .limit(limit);
}

export type FolderNeighbours = {
  /** The article after this one in the folder's own order, or null on the last. */
  next: ArticleLink | null;
  /** The folder's other articles, most helpful first, the next one left out. */
  related: ArticleSummary[];
};

/**
 * What the article page needs from the article's folder: "Next article" and
 * the rail's "Related articles", from one read of the folder.
 *
 * One query rather than one for each. This is the help centre's most visited
 * page, every query on it waits at the pool's admission gate, and both answers
 * come from the same few rows — production's largest folder holds fifteen.
 *
 * "Next" follows the order `getFolder` lists the folder in, position then
 * title, so the link is to the row a reader would have met next on the folder's
 * page; null on the last article, or one the folder cannot find, rather than
 * wrapping round to the first. "Related" is the rest by how often readers said
 * an article helped, ties left in the editor's order, without the article
 * already offered as Next. Locale is filtered as `getFolder` filters it, so the
 * three lists agree about which rows the folder holds.
 */
export async function folderNeighbours(
  viewer: KbViewer,
  locale: Locale,
  folderId: string,
  articleId: string,
  relatedLimit = 5,
): Promise<FolderNeighbours> {
  const rows = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      excerpt: kbArticles.excerpt,
      helpfulCount: kbArticles.helpfulCount,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.folderId, folderId),
        eq(kbArticles.locale, locale),
        articleVisibleTo(viewer),
      ),
    )
    .orderBy(asc(kbArticles.position), asc(kbArticles.title));

  const index = rows.findIndex((row) => row.id === articleId);
  const nextRow = index >= 0 ? (rows[index + 1] ?? null) : null;

  // `sort` is stable, so rows readers rated alike keep the editor's order.
  const related = rows
    .filter((row) => row.id !== articleId && row.id !== nextRow?.id)
    .sort((a, b) => b.helpfulCount - a.helpfulCount)
    .slice(0, relatedLimit)
    .map(({ id, title, slug, excerpt }) => ({ id, title, slug, excerpt }));

  return {
    next: nextRow ? { id: nextRow.id, title: nextRow.title, slug: nextRow.slug } : null,
    related,
  };
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
  /**
   * A category's slug, for the search box on a category page. The design's
   * "Search in Shipments & tracking" — and a slug that names no category simply
   * matches nothing, the same answer an empty category gives.
   */
  withinCategory?: string,
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
        withinCategory ? eq(kbCategories.slug, withinCategory) : undefined,
      ),
    )
    .orderBy(desc(rank), asc(kbArticles.title))
    .limit(limit);

  return rows;
}

/**
 * Resolves a legacy Freshdesk path.
 *
 * Reached only for a path the proxy already recognised as a Freshdesk URL,
 * which is why this is not in the hot path: after cutover almost all traffic
 * uses the new URLs, and looking every request up here would add a query to
 * every page load to serve a shrinking minority.
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
      // The last edit, so a crawler is told a page changed when its content did
      // rather than whenever somebody read it.
      updatedAt: editedAt,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(articleVisibleTo(viewer), folderVisibleTo(viewer)))
    .orderBy(desc(editedAt));
}
