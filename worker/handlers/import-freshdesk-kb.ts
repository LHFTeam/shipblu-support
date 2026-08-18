import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { env } from '@/lib/env';
import {
  listArticles,
  listCategories,
  listFolders,
  mapStatus,
  mapVisibility,
} from '@/lib/freshdesk/client';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { slugify, uniqueSlug } from '@/lib/kb/slug';

/**
 * Imports the Freshdesk knowledge base.
 *
 * Idempotent on `(source_system, external_id)` throughout, so this is safe to
 * run repeatedly — which is the point. A migration is never one clean run: it
 * is a rehearsal weeks early, several more as content changes, and a final one
 * on cutover day. Anything that could only be run once would have to be undone
 * by hand between attempts.
 *
 * Locally-authored articles are never touched: every write is scoped to rows
 * whose `source_system` is 'freshdesk', so a re-run cannot overwrite something
 * the team wrote here.
 */
export async function importFreshdeskKb(): Promise<void> {
  const e = env();
  if (!e.FRESHDESK_DOMAIN || !e.FRESHDESK_API_KEY) {
    console.log('[import_freshdesk_kb] FRESHDESK_DOMAIN / FRESHDESK_API_KEY not set — skipping');
    return;
  }

  const started = Date.now();
  let categoryCount = 0;
  let folderCount = 0;
  let articleCount = 0;
  const failures: string[] = [];

  const categories = await listCategories();

  for (const category of categories) {
    try {
      const categoryId = await upsertCategory(category);
      categoryCount += 1;

      const folders = await listFolders(category.id);

      for (const folder of folders) {
        try {
          const folderId = await upsertFolder(folder, categoryId);
          folderCount += 1;

          const articles = await listArticles(folder.id);

          for (const article of articles) {
            try {
              await upsertArticle(article, folderId);
              articleCount += 1;
            } catch (error) {
              failures.push(`article ${article.id}: ${message(error)}`);
            }
          }
        } catch (error) {
          failures.push(`folder ${folder.id}: ${message(error)}`);
        }
      }
    } catch (error) {
      failures.push(`category ${category.id}: ${message(error)}`);
    }
  }

  console.log(
    `[import_freshdesk_kb] ${categoryCount} categories, ${folderCount} folders, ` +
      `${articleCount} articles in ${Math.round((Date.now() - started) / 1000)}s` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );

  if (failures.length) {
    // Logged individually, then thrown as a summary: a partial import is
    // recoverable by re-running, but it must not look like a success.
    for (const failure of failures.slice(0, 20)) {
      console.error(`[import_freshdesk_kb] ${failure}`);
    }
    throw new Error(`${failures.length} item(s) failed to import`);
  }
}

/**
 * Freshdesk's own language, which we cannot read per-category through this
 * endpoint. Everything imports into the default locale and the team moves the
 * Arabic tree afterwards — guessing from the text would file articles wrongly,
 * and a wrong locale makes an article unreachable rather than merely untidy.
 */
const IMPORT_LOCALE = DEFAULT_LOCALE;

async function upsertCategory(category: {
  id: number;
  name: string;
  description?: string | null;
}): Promise<string> {
  const externalId = String(category.id);

  const existing = await db
    .select({ id: kbCategories.id })
    .from(kbCategories)
    .where(eq(kbCategories.externalId, externalId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(kbCategories)
      .set({
        name: category.name,
        description: category.description ?? null,
        updatedAt: new Date(),
      })
      .where(eq(kbCategories.id, existing[0].id));
    return existing[0].id;
  }

  const taken = await db
    .select({ slug: kbCategories.slug })
    .from(kbCategories)
    .where(eq(kbCategories.locale, IMPORT_LOCALE));

  const inserted = await db
    .insert(kbCategories)
    .values({
      name: category.name,
      slug: uniqueSlug(
        slugify(category.name, `category-${externalId}`),
        taken.map((row) => row.slug),
      ),
      description: category.description ?? null,
      locale: IMPORT_LOCALE,
      sourceSystem: 'freshdesk',
      externalId,
    })
    .returning({ id: kbCategories.id });

  return inserted[0]!.id;
}

async function upsertFolder(
  folder: { id: number; name: string; description?: string | null; visibility?: number },
  categoryId: string,
): Promise<string> {
  const externalId = String(folder.id);
  const visibility = mapVisibility(folder.visibility);

  const existing = await db
    .select({ id: kbFolders.id })
    .from(kbFolders)
    .where(eq(kbFolders.externalId, externalId))
    .limit(1);

  if (existing[0]) {
    await db
      .update(kbFolders)
      .set({
        name: folder.name,
        description: folder.description ?? null,
        visibility,
        categoryId,
        updatedAt: new Date(),
      })
      .where(eq(kbFolders.id, existing[0].id));
    return existing[0].id;
  }

  const taken = await db
    .select({ slug: kbFolders.slug })
    .from(kbFolders)
    .where(eq(kbFolders.categoryId, categoryId));

  const inserted = await db
    .insert(kbFolders)
    .values({
      name: folder.name,
      slug: uniqueSlug(
        slugify(folder.name, `folder-${externalId}`),
        taken.map((row) => row.slug),
      ),
      description: folder.description ?? null,
      categoryId,
      visibility,
      sourceSystem: 'freshdesk',
      externalId,
    })
    .returning({ id: kbFolders.id });

  return inserted[0]!.id;
}

async function upsertArticle(
  article: {
    id: number;
    title: string;
    description?: string | null;
    status?: number;
    seo_data?: { meta_title?: string; meta_description?: string };
    tags?: string[];
    hits?: number;
    thumbs_up?: number;
    thumbs_down?: number;
  },
  folderId: string,
): Promise<void> {
  const externalId = String(article.id);

  // Freshdesk HTML is years of accumulated pastes from Word, other help desks
  // and hand-written markup, so it goes through the same sanitiser as anything
  // an agent writes. Sanitising at import rather than at render means the
  // stored row is safe for every consumer.
  const bodyHtml = sanitiseArticleHtml(article.description ?? '');
  const bodyText = htmlToText(bodyHtml);

  const values = {
    title: article.title,
    bodyHtml,
    bodyText,
    excerpt: preview(bodyText, 200),
    folderId,
    status: mapStatus(article.status),
    tags: article.tags ?? [],
    seo: {
      ...(article.seo_data?.meta_title ? { title: article.seo_data.meta_title } : {}),
      ...(article.seo_data?.meta_description
        ? { description: article.seo_data.meta_description }
        : {}),
    },
    // Carried across so "most read" ordering does not reset to zero on cutover
    // and lose years of signal about which articles matter.
    viewCount: article.hits ?? 0,
    helpfulCount: article.thumbs_up ?? 0,
    unhelpfulCount: article.thumbs_down ?? 0,
    updatedAt: new Date(),
  };

  const existing = await db
    .select({ id: kbArticles.id, slug: kbArticles.slug })
    .from(kbArticles)
    .where(eq(kbArticles.externalId, externalId))
    .limit(1);

  let articleId: string;
  let slug: string;

  if (existing[0]) {
    // The slug is deliberately not recomputed on re-import. It is the public
    // URL, and a title tweak in Freshdesk between rehearsal and cutover must
    // not silently move a page that is already linked to.
    articleId = existing[0].id;
    slug = existing[0].slug;
    await db.update(kbArticles).set(values).where(eq(kbArticles.id, articleId));
  } else {
    const taken = await db
      .select({ slug: kbArticles.slug })
      .from(kbArticles)
      .where(eq(kbArticles.locale, IMPORT_LOCALE));

    slug = uniqueSlug(
      slugify(article.title, `article-${externalId}`),
      taken.map((row) => row.slug),
    );

    const inserted = await db
      .insert(kbArticles)
      .values({
        ...values,
        slug,
        locale: IMPORT_LOCALE,
        // Freshdesk's folder visibility is the real gate; an article inherits
        // it, and the folder check on the public side enforces it again.
        visibility: 'public',
        sourceSystem: 'freshdesk',
        externalId,
      })
      .returning({ id: kbArticles.id });

    articleId = inserted[0]!.id;
  }

  // Redirects for every URL shape a Freshdesk account can serve. The article's
  // external_id also resolves these at request time, so these rows are belt to
  // that brace — they cost nothing and they survive the article being
  // re-sourced later.
  const legacyPaths = [
    `/support/solutions/articles/${externalId}`,
    `/solutions/articles/${externalId}`,
    `/a/solutions/articles/${externalId}`,
  ];

  for (const fromPath of legacyPaths) {
    await db
      .insert(kbRedirects)
      .values({ fromPath, articleId })
      .onConflictDoUpdate({ target: kbRedirects.fromPath, set: { articleId } });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
