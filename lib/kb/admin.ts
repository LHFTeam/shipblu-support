import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import type { AgentRole } from '@/lib/auth/permissions';
import { effectiveFloor, readableByRole } from './internal';

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
  visibility: string;
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
  if (filters.q) {
    const term = `%${filters.q}%`;
    where.push(or(ilike(kbArticles.title, term), ilike(kbArticles.slug, term))!);
  }

  return db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      slug: kbArticles.slug,
      locale: kbArticles.locale,
      status: kbArticles.status,
      visibility: kbArticles.visibility,
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
    })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(and(eq(kbArticles.id, id), readableByRole(role)))
    .limit(1);

  const row = rows[0];
  return row
    ? { ...row.article, categoryId: row.categoryId, effectiveMinRole: row.effectiveMinRole }
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

export async function getVersionBody(versionId: string): Promise<string | null> {
  const rows = await db
    .select({ bodyHtml: kbArticleVersions.bodyHtml })
    .from(kbArticleVersions)
    .where(eq(kbArticleVersions.id, versionId))
    .limit(1);

  return rows[0]?.bodyHtml ?? null;
}

/** Slugs already used in a locale, so the editor can offer a free one. */
export async function takenSlugs(locale: string, excludeArticleId?: string): Promise<string[]> {
  const rows = await db
    .select({ slug: kbArticles.slug, id: kbArticles.id })
    .from(kbArticles)
    .where(eq(kbArticles.locale, locale));

  return rows.filter((row) => row.id !== excludeArticleId).map((row) => row.slug);
}
