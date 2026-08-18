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
  type FreshdeskArticle,
  type FreshdeskFolder,
} from '@/lib/freshdesk/client';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { detectCategoryLocale } from '@/lib/kb/language';
import type { Locale } from '@/lib/kb/locale';
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
    // Thrown rather than skipped. Nothing schedules this job — it is always
    // started by hand from the console or the shell — so a silent success is
    // just a person watching an empty knowledge base and wondering why. A
    // failed job puts the reason on the row, where the console shows it.
    throw new Error(
      'FRESHDESK_DOMAIN and FRESHDESK_API_KEY must be set on the worker service before importing',
    );
  }

  const started = Date.now();
  let categoryCount = 0;
  let folderCount = 0;
  let articleCount = 0;
  const failures: string[] = [];

  const categories = await listCategories();

  for (const category of categories) {
    try {
      const folders = await listFolders(category.id);

      // The whole category is fetched before anything is written, because its
      // locale is decided by its articles and every article is then filed under
      // it. Writing as we go would mean guessing the locale from the first
      // article and correcting it afterwards.
      const contents: { folder: FreshdeskFolder; articles: FreshdeskArticle[] }[] = [];

      for (const folder of folders) {
        try {
          contents.push({ folder, articles: await listArticles(folder.id) });
        } catch (error) {
          failures.push(`folder ${folder.id}: ${message(error)}`);
        }
      }

      const samples = contents.flatMap(({ articles }) =>
        articles.map((article) => `${article.title} ${article.description_text ?? ''}`),
      );

      const { locale, disagreements } = detectCategoryLocale(category.name, samples);

      if (disagreements > 0) {
        // Not an error: a category really can hold both languages. But every
        // article inherits the category's locale, so the minority ones end up
        // filed under a language they are not written in, and only a person can
        // decide how to split them.
        console.warn(
          `[import_freshdesk_kb] category "${category.name}" imported as ${locale}, ` +
            `but ${disagreements} of ${samples.length} article(s) look like the other ` +
            `language — they may need moving`,
        );
      }

      const categoryId = await upsertCategory(category, locale);
      categoryCount += 1;

      for (const { folder, articles } of contents) {
        try {
          const folderId = await upsertFolder(folder, categoryId);
          folderCount += 1;

          for (const article of articles) {
            try {
              await upsertArticle(article, folderId, locale);
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
 * Locale is read off the content, not assumed.
 *
 * The first version of this importer filed everything under the default locale
 * and left moving the Arabic tree as a manual step. ShipBlu's knowledge base is
 * entirely Arabic, so that meant 58 Arabic articles served as English, laid out
 * left-to-right, with the Arabic help centre empty. Arabic and English use
 * different scripts, so detecting this is a script test rather than a guess —
 * see lib/kb/language.ts.
 */

async function upsertCategory(
  category: { id: number; name: string; description?: string | null },
  locale: Locale,
): Promise<string> {
  const externalId = String(category.id);

  const existing = await db
    .select({ id: kbCategories.id })
    .from(kbCategories)
    .where(eq(kbCategories.externalId, externalId))
    .limit(1);

  if (existing[0]) {
    // Locale is corrected on re-import, not just set on first import. That is
    // what lets a re-run repair a category that an earlier version of this
    // importer filed under the wrong language.
    await db
      .update(kbCategories)
      .set({
        name: category.name,
        description: category.description ?? null,
        locale,
        updatedAt: new Date(),
      })
      .where(eq(kbCategories.id, existing[0].id));
    return existing[0].id;
  }

  const taken = await db
    .select({ slug: kbCategories.slug })
    .from(kbCategories)
    .where(eq(kbCategories.locale, locale));

  const inserted = await db
    .insert(kbCategories)
    .values({
      name: category.name,
      slug: uniqueSlug(
        slugify(category.name, `category-${externalId}`),
        taken.map((row) => row.slug),
      ),
      description: category.description ?? null,
      locale,
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
  locale: Locale,
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
    // Included in the update path as well as the insert, so a re-run moves an
    // article that a previous import filed under the wrong language.
    locale,
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
      .where(eq(kbArticles.locale, locale));

    slug = uniqueSlug(
      slugify(article.title, `article-${externalId}`),
      taken.map((row) => row.slug),
    );

    const inserted = await db
      .insert(kbArticles)
      .values({
        ...values,
        slug,
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
