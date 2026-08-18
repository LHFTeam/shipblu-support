import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';

/**
 * Read models for KB authoring.
 *
 * Separate from `queries.ts` on purpose. Those queries must never return a
 * draft or an internal article; these must return everything. Keeping the two
 * sets in different files means a copy-paste between them is visible in review
 * rather than being a one-word difference in a where clause.
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
  folderName: string;
  categoryName: string;
  updatedAt: Date;
  viewCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
};

export async function listArticlesForAdmin(filters: ArticleFilters): Promise<AdminArticleRow[]> {
  const where: SQL[] = [];

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
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(kbArticles.updatedAt))
    .limit(200);
}

export type EditableArticle = typeof kbArticles.$inferSelect & {
  categoryId: string;
};

export async function getArticleForEdit(id: string): Promise<EditableArticle | null> {
  const rows = await db
    .select({ article: kbArticles, categoryId: kbFolders.categoryId })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(eq(kbArticles.id, id))
    .limit(1);

  const row = rows[0];
  return row ? { ...row.article, categoryId: row.categoryId } : null;
}

export type FolderOption = {
  id: string;
  name: string;
  categoryName: string;
  categoryLocale: string;
};

/** Every folder, grouped for a picker. Small enough to load in one go. */
export async function listFolderOptions(): Promise<FolderOption[]> {
  return db
    .select({
      id: kbFolders.id,
      name: kbFolders.name,
      categoryName: kbCategories.name,
      categoryLocale: kbCategories.locale,
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
