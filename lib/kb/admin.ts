import { and, asc, desc, eq, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import type { AgentRole } from '@/lib/auth/permissions';
import { folderFloor, meetsFloor } from './floors';
import type { ArticleVisibility } from './floors';
import { effectiveFloor, effectiveVisibility, readableByRole } from './internal';
import { cleanQuery, textMatches, textPatterns } from '@/lib/search/text';

/**
 * Read models for KB authoring.
 *
 * Separate from `queries.ts` on purpose. Those queries must never return a
 * draft or an internal article; these must return everything within the
 * reader's reach. Keeping the two sets in different files means a copy-paste
 * between them is visible in review rather than being a one-word difference in
 * a where clause.
 *
 * "Within the reader's reach" is the one thing these do gate, and both of them
 * take a role for it. An internal article can carry a floor — supervisors and
 * up, admins and up — and this is the surface where somebody reads a whole
 * article rather than a search snippet, so it is the surface where a missing
 * predicate publishes an internal runbook to the whole team.
 */

export type ArticleFilters = {
  status: 'all' | 'draft' | 'published' | 'archived';
  locale: 'all' | 'en' | 'ar';
  q: string;
};

export function parseArticleFilters(
  params: Record<string, string | string[] | undefined>,
): ArticleFilters {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const status = one('status');
  const locale = one('locale');

  return {
    status: status === 'draft' || status === 'published' || status === 'archived' ? status : 'all',
    locale: locale === 'en' || locale === 'ar' ? locale : 'all',
    q: (one('q') ?? '').trim(),
  };
}

export type AdminArticleRow = {
  id: string;
  title: string;
  slug: string;
  locale: string;
  status: string;
  /**
   * The stricter of the article's own level and its folder's, never the column.
   *
   * Production's internal articles carry `visibility = 'public'` and are
   * internal only through their folder, so a badge drawn from the column reads
   * "public" on the fifteen rows where saying so is most misleading.
   */
  visibility: ArticleVisibility;
  /** The floor in force, or null. Null on everything a customer may read. */
  minRole: AgentRole | null;
  folderName: string;
  categoryName: string;
  updatedAt: Date;
  viewCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
};

export async function listArticlesForAdmin(
  role: AgentRole,
  filters: ArticleFilters,
): Promise<AdminArticleRow[]> {
  const where: SQL[] = [readableByRole(role)];

  if (filters.status !== 'all') where.push(eq(kbArticles.status, filters.status));
  if (filters.locale !== 'all') where.push(eq(kbArticles.locale, filters.locale));
  const q = cleanQuery(filters.q);
  if (q) {
    // Titles are mostly Arabic, and one article's إلغاء is the next one's الغاء.
    const text = textPatterns(q);
    where.push(or(textMatches(kbArticles.title, text), textMatches(kbArticles.slug, text))!);
  }

  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      locale: kbArticles.locale,
      status: kbArticles.status,
      visibility: effectiveVisibility,
      minRole: effectiveFloor,
      folderName: kbFolders.name,
      categoryName: kbCategories.name,
      updatedAt: kbArticles.updatedAt,
      viewCount: kbArticles.viewCount,
      helpfulCount: kbArticles.helpfulCount,
      unhelpfulCount: kbArticles.unhelpfulCount,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .where(and(...where))
    .orderBy(desc(kbArticles.updatedAt))
    .limit(200);
}

export type EditableArticle = typeof kbArticles.$inferSelect & {
  categoryId: string;
  /** The floor in force, folder included — what the editor shows and re-saves. */
  effectiveMinRole: AgentRole | null;
  /**
   * The level in force, folder included.
   *
   * `visibility` on the row beside it is what the editor's control edits; this
   * is what decides whether the article is reachable on the help centre, so
   * anything offering a public URL reads this one.
   */
  effectiveVisibility: ArticleVisibility;
};

/**
 * One article, for reading or editing.
 *
 * Answers null for an article above the reader's floor rather than throwing, so
 * every caller already handles it: the page 404s and the actions refuse. That
 * is the same answer they give for an id that does not exist, which is the
 * right one — "you may not read this" and "this is not here" should not be
 * distinguishable by trying ids.
 */
export async function getArticleForEdit(
  id: string,
  role: AgentRole,
): Promise<EditableArticle | null> {
  const rows = await db
    .select({
      article: kbArticles,
      categoryId: kbFolders.categoryId,
      effectiveMinRole: effectiveFloor,
      effectiveVisibility,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(eq(kbArticles.id, id), readableByRole(role)))
    .limit(1);

  const row = rows[0];
  return row
    ? {
        ...row.article,
        categoryId: row.categoryId,
        effectiveMinRole: row.effectiveMinRole,
        effectiveVisibility: row.effectiveVisibility,
      }
    : null;
}

export type FolderOption = {
  id: string;
  name: string;
  categoryName: string;
  categoryLocale: string;
  /**
   * Carried because one picker has to exclude some of these.
   *
   * The widget's FAQ folder is chosen from this list and then read with an
   * anonymous viewer, so a folder that is not `public` yields an empty list on
   * the customer's screen while looking configured on the admin's. Production
   * has four `agents_only` folders — the staff handbook — whose articles are
   * individually marked `published`/`public`, which is exactly the pairing that
   * makes the mistake plausible.
   */
  visibility: string;
  /**
   * The folder's own role floor, so the editor can say what filing an article
   * here already implies. An article cannot be made *more* readable than the
   * folder it sits in, and an author who cannot see that is an author who will
   * wonder why their article is missing from a colleague's list.
   */
  minRole: AgentRole | null;
};

/** Every folder, grouped for a picker. Small enough to load in one go. */
export async function listFolderOptions(): Promise<FolderOption[]> {
  return db
    .select({
      id: kbFolders.id,
      name: kbFolders.name,
      categoryName: kbCategories.name,
      categoryLocale: kbCategories.locale,
      visibility: kbFolders.visibility,
      minRole: kbFolders.minRole,
    })
    .from(kbFolders)
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .orderBy(asc(kbCategories.position), asc(kbCategories.name), asc(kbFolders.position));
}

/**
 * The same list, cut down to the folders a reader may actually use.
 *
 * `listFolderOptions` stays unfiltered, because its other two callers are
 * asking a different question: the widget's FAQ folder is chosen by an admin
 * and validated by `resolveFaqFolders` against every folder there is, and a
 * picker that quietly dropped one would look like the folder had been deleted.
 * The editor's picker is not that. A supervisor offered the account-admins
 * handbook folder files an article they cannot open: the `redirect()` after the
 * save 404s on them, and the article is then missing from their list and out of
 * reach of every action, because all of those apply `readableByRole`.
 *
 * The floor is read off the folder alone — `folderFloor` is null on anything a
 * customer can open, the same cut `effectiveFloor` makes — so this is the SQL
 * rule over rows in hand rather than a second rule.
 */
export async function listFolderOptionsForRole(role: AgentRole): Promise<FolderOption[]> {
  const folders = await listFolderOptions();
  return folders.filter((folder) => meetsFloor(role, folderFloor(folder)));
}

export async function listCategoriesForAdmin() {
  return db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      slug: kbCategories.slug,
      locale: kbCategories.locale,
      folderCount: sql<number>`count(${kbFolders.id})::int`,
    })
    .from(kbCategories)
    .leftJoin(kbFolders, eq(kbFolders.categoryId, kbCategories.id))
    .groupBy(kbCategories.id)
    .orderBy(asc(kbCategories.locale), asc(kbCategories.position), asc(kbCategories.name));
}

export type ArticleVersion = {
  id: string;
  version: number;
  title: string;
  editedBy: string | null;
  createdAt: Date;
};

export async function listVersions(articleId: string): Promise<ArticleVersion[]> {
  return db
    .select({
      id: kbArticleVersions.id,
      version: kbArticleVersions.version,
      title: kbArticleVersions.title,
      editedBy: agents.name,
      createdAt: kbArticleVersions.createdAt,
    })
    .from(kbArticleVersions)
    .leftJoin(agents, eq(agents.id, kbArticleVersions.editedByAgentId))
    .where(eq(kbArticleVersions.articleId, articleId))
    .orderBy(desc(kbArticleVersions.version))
    .limit(30);
}

/** Slugs already used in a locale, so the editor can offer a free one. */
export async function takenSlugs(locale: string, excludeArticleId?: string): Promise<string[]> {
  const rows = await db
    .select({ slug: kbArticles.slug, id: kbArticles.id })
    .from(kbArticles)
    .where(eq(kbArticles.locale, locale));

  return rows.filter((row) => row.id !== excludeArticleId).map((row) => row.slug);
}

export type TranslationOption = {
  id: string;
  title: string;
  locale: string;
  status: string;
};

export type TranslationGroup = {
  /** The other members of this article's group that the reader may open. */
  readable: TranslationOption[];
  /** How many other members it has in total, readable or not. */
  total: number;
};

/**
 * What this article is already linked to.
 *
 * Its own query rather than a filter over the candidate list, for two reasons
 * that both end in the console asserting something false. A capped list can
 * truncate the one row that matters, and `readableByRole` can hide it — either
 * way an article with a translation renders as having none, and the obvious
 * remedy (link it again) moves it somewhere else and orphans the pair.
 *
 * So `total` is counted **without** the role filter while `readable` applies
 * it. Nothing leaks: a count says a translation exists, which the help centre's
 * language switcher already says to anyone who can read either article, whereas
 * the title is what an admins-only runbook is being kept from. A group has one
 * article per locale, so this is two or three rows, not a scan.
 */
export async function translationGroupOf(
  articleId: string,
  translationGroupId: string,
  role: AgentRole,
): Promise<TranslationGroup> {
  const others = and(
    eq(kbArticles.translationGroupId, translationGroupId),
    ne(kbArticles.id, articleId),
  )!;

  const [readable, counted] = await Promise.all([
    db
      .select({
        id: kbArticles.id,
        title: kbArticles.title,
        locale: kbArticles.locale,
        status: kbArticles.status,
      })
      .from(kbArticles)
      .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
      .where(and(others, readableByRole(role)))
      .orderBy(asc(kbArticles.locale)),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(others),
  ]);

  return { readable, total: counted[0]?.total ?? 0 };
}

/**
 * The articles this one could become a translation of.
 *
 * Three conditions, and the third is the one that is easy to miss. A candidate
 * must be readable — an unfiltered dropdown would let a supervisor discover the
 * titles of admins-only runbooks, which is exactly the population a floor keeps
 * them from. It must be in another language, because a group holds one article
 * per locale. And **its group must not already hold this article's locale**:
 * joining one that does produces a group with two `ar` articles, which
 * `translationsOf` does not de-duplicate — the help centre then renders two
 * switcher links with the same React key and `generateMetadata` silently drops
 * one of the two hreflang alternates. There is no unlink, so that group cannot
 * be repaired from the console.
 *
 * Filtered in SQL rather than in the component so the cap below cannot let a
 * bad option through, and `linkTranslation` refuses the same case server-side
 * because a picker is a convenience and not a guarantee.
 */
export async function listTranslationCandidates(
  articleId: string,
  locale: string,
  role: AgentRole,
): Promise<TranslationOption[]> {
  // Every group that already holds this locale — including this article's own,
  // since it is in this locale, which is why no separate exclusion of
  // `translationGroupId` is needed. A subquery rather than a correlated
  // `not exists`: `notInArray` is a typed operator drizzle binds itself, where a
  // raw fragment naming an aliased table is a statement no test here can
  // execute (AGENTS.md, Tests). `translation_group_id` is `not null`, so the
  // `NOT IN` cannot be poisoned by a null.
  const groupsHoldingThisLocale = db
    .select({ groupId: kbArticles.translationGroupId })
    .from(kbArticles)
    .where(eq(kbArticles.locale, locale));

  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      locale: kbArticles.locale,
      status: kbArticles.status,
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(
      and(
        ne(kbArticles.id, articleId),
        ne(kbArticles.locale, locale),
        notInArray(kbArticles.translationGroupId, groupsHoldingThisLocale),
        readableByRole(role),
      ),
    )
    .orderBy(asc(kbArticles.locale), asc(kbArticles.title))
    .limit(500);
}

/**
 * Whether the target group already holds an article in `locale`.
 *
 * Deliberately **not** role-filtered: an article the caller cannot see still
 * occupies its locale's slot in the group, so filtering here would let a
 * supervisor create the duplicate-locale group the candidate query exists to
 * prevent. It returns a boolean, so it reports that the slot is taken without
 * naming what took it.
 */
export async function translationGroupHasLocale(
  translationGroupId: string,
  locale: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: kbArticles.id })
    .from(kbArticles)
    .where(
      and(eq(kbArticles.translationGroupId, translationGroupId), eq(kbArticles.locale, locale)),
    )
    .limit(1);

  return rows.length > 0;
}
