import { and, eq, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { env } from '@/lib/env';
import {
  discoverLanguageCode,
  getTranslatedArticle,
  getTranslatedCategory,
  getTranslatedFolder,
  listArticles,
  listCategories,
  listFolders,
  mapStatus,
  mapVisibility,
  type FreshdeskArticle,
  type FreshdeskCategory,
  type FreshdeskFolder,
} from '@/lib/freshdesk/client';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { detectCategoryLocale } from '@/lib/kb/language';
import { LOCALES, type Locale } from '@/lib/kb/locale';
import { slugify, uniqueSlug } from '@/lib/kb/slug';

/**
 * Imports the Freshdesk knowledge base, in every language it is published in.
 *
 * Freshdesk models translations as one item with several language versions, and
 * exposes them only per item, by id — its list endpoints return the account's
 * primary language and nothing else. So the shape of this import is: walk the
 * primary tree, then for every category, folder and article ask for each other
 * language by id.
 *
 * Idempotent on `(source_system, external_id)` throughout, so it is safe to run
 * repeatedly — which is the point. A migration is never one clean run: it is a
 * rehearsal weeks early, several more as content changes, and a final pass on
 * cutover day.
 *
 * Locally-authored articles are never touched: every write is scoped to rows
 * whose `source_system` is 'freshdesk'.
 */
export async function importFreshdeskKb(): Promise<void> {
  const e = env();
  if (!e.FRESHDESK_DOMAIN || !e.FRESHDESK_API_KEY) {
    // Thrown rather than skipped. Nothing schedules this job — it is always
    // started by hand from the console or the shell — so a silent success is
    // just a person watching an empty knowledge base and wondering why.
    throw new Error(
      'FRESHDESK_DOMAIN and FRESHDESK_API_KEY must be set on the worker service before importing',
    );
  }

  const started = Date.now();
  const failures: string[] = [];
  let categoryCount = 0;
  let folderCount = 0;
  let articleCount = 0;
  let translatedCount = 0;

  const categories = await listCategories();
  if (categories.length === 0) {
    console.warn('[import_freshdesk_kb] Freshdesk returned no categories');
    return;
  }

  // Which code this account uses for each language, asked once against a real
  // category. A wrong code 404s on every item, which is indistinguishable from
  // "nothing is translated" — so guessing it would make the import quietly find
  // nothing and still report success.
  const codes = new Map<Locale, string>();
  for (const locale of LOCALES) {
    const code = await discoverLanguageCode(categories[0]!.id, locale);
    if (code) codes.set(locale, code);
  }

  console.log(
    `[import_freshdesk_kb] language codes: ${
      [...codes].map(([locale, code]) => `${locale}=${code}`).join(', ') || 'none found'
    }`,
  );

  for (const category of categories) {
    try {
      const folders = await listFolders(category.id);

      // The whole category is read before anything is written, because its
      // locale is decided by its articles and every article is filed under it.
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

      const { locale: primaryLocale, disagreements } = detectCategoryLocale(category.name, samples);

      if (disagreements > 0) {
        // A category really can hold both languages, but every article inherits
        // the category's locale, so the minority ones end up filed under a
        // language they are not written in. Only a person can decide how to
        // split them, and this is how they find out.
        console.warn(
          `[import_freshdesk_kb] category "${category.name}" imported as ${primaryLocale}, ` +
            `but ${disagreements} of ${samples.length} article(s) look like the other language`,
        );
      }

      // --- primary language ------------------------------------------------

      const primaryCategory = await upsertCategory(category, primaryLocale);
      categoryCount += 1;

      const articleGroups = new Map<number, string>();

      for (const { folder, articles } of contents) {
        try {
          const folderId = await upsertFolder(folder, primaryCategory.id, primaryLocale);
          folderCount += 1;

          for (const article of articles) {
            try {
              const result = await upsertArticle(article, folderId, primaryLocale);
              articleGroups.set(article.id, result.translationGroupId);
              await writeRedirects(article.id, result.id);
              articleCount += 1;
            } catch (error) {
              failures.push(`article ${article.id}: ${message(error)}`);
            }
          }
        } catch (error) {
          failures.push(`folder ${folder.id}: ${message(error)}`);
        }
      }

      // --- every other language --------------------------------------------

      for (const [locale, code] of codes) {
        if (locale === primaryLocale) continue;

        try {
          const translatedCategory = await getTranslatedCategory(category.id, code);
          // No translated category means this whole branch is untranslated —
          // its folders and articles would have nowhere to live.
          if (!translatedCategory) continue;

          const categoryRow = await upsertCategory(
            { ...translatedCategory, id: category.id },
            locale,
            primaryCategory.translationGroupId,
          );
          categoryCount += 1;

          for (const { folder, articles } of contents) {
            const translatedFolder = await getTranslatedFolder(folder.id, code);
            if (!translatedFolder) continue;

            const folderId = await upsertFolder(
              // Visibility comes from the primary folder: it is an access rule,
              // not translated content, and a translation that omitted it would
              // silently widen who can see the articles.
              { ...translatedFolder, id: folder.id, visibility: folder.visibility },
              categoryRow.id,
              locale,
            );
            folderCount += 1;

            for (const article of articles) {
              try {
                const translatedArticle = await getTranslatedArticle(article.id, code);
                if (!translatedArticle) continue;

                await upsertArticle(
                  { ...translatedArticle, id: article.id, status: article.status },
                  folderId,
                  locale,
                  articleGroups.get(article.id),
                );
                translatedCount += 1;
              } catch (error) {
                failures.push(`article ${article.id} (${locale}): ${message(error)}`);
              }
            }
          }
        } catch (error) {
          failures.push(`category ${category.id} (${locale}): ${message(error)}`);
        }
      }
    } catch (error) {
      failures.push(`category ${category.id}: ${message(error)}`);
    }
  }

  console.log(
    `[import_freshdesk_kb] ${categoryCount} categories, ${folderCount} folders, ` +
      `${articleCount} articles, ${translatedCount} translations in ` +
      `${Math.round((Date.now() - started) / 1000)}s` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );

  if (failures.length) {
    for (const failure of failures.slice(0, 20)) {
      console.error(`[import_freshdesk_kb] ${failure}`);
    }
    throw new Error(`${failures.length} item(s) failed to import`);
  }
}

/**
 * External ids are scoped by locale — `"72000123456:ar"`.
 *
 * One Freshdesk article becomes one row per language here, and they cannot all
 * claim the same external id: the unique index is on
 * `(source_system, external_id)`.
 */
function externalIdFor(freshdeskId: number, locale: Locale): string {
  return `${freshdeskId}:${locale}`;
}

/**
 * Matches the locale-scoped id, or the bare one an earlier version wrote.
 *
 * This is what lets a re-run adopt and repair the rows already imported rather
 * than creating a second copy beside them.
 */
function matchesExternalId(column: PgColumn, id: number, locale: Locale) {
  return or(eq(column, externalIdFor(id, locale)), eq(column, String(id)))!;
}

async function upsertCategory(
  category: FreshdeskCategory,
  locale: Locale,
  translationGroupId?: string,
): Promise<{ id: string; translationGroupId: string }> {
  const externalId = externalIdFor(category.id, locale);

  const existing = await db
    .select({ id: kbCategories.id, translationGroupId: kbCategories.translationGroupId })
    .from(kbCategories)
    .where(
      and(
        eq(kbCategories.sourceSystem, 'freshdesk'),
        matchesExternalId(kbCategories.externalId, category.id, locale),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // Locale and external id are both corrected on re-import, not only set on
    // insert — that is what repairs rows written by an earlier version.
    await db
      .update(kbCategories)
      .set({
        name: category.name,
        description: category.description ?? null,
        locale,
        externalId,
        ...(translationGroupId ? { translationGroupId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(kbCategories.id, existing[0].id));

    return {
      id: existing[0].id,
      translationGroupId: translationGroupId ?? existing[0].translationGroupId,
    };
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
        slugify(category.name, `category-${category.id}`),
        taken.map((row) => row.slug),
      ),
      description: category.description ?? null,
      locale,
      ...(translationGroupId ? { translationGroupId } : {}),
      sourceSystem: 'freshdesk',
      externalId,
    })
    .returning({ id: kbCategories.id, translationGroupId: kbCategories.translationGroupId });

  return inserted[0]!;
}

async function upsertFolder(
  folder: FreshdeskFolder,
  categoryId: string,
  locale: Locale,
): Promise<string> {
  const externalId = externalIdFor(folder.id, locale);
  const visibility = mapVisibility(folder.visibility);

  const existing = await db
    .select({ id: kbFolders.id })
    .from(kbFolders)
    .where(
      and(
        eq(kbFolders.sourceSystem, 'freshdesk'),
        matchesExternalId(kbFolders.externalId, folder.id, locale),
      ),
    )
    .limit(1);

  if (existing[0]) {
    await db
      .update(kbFolders)
      .set({
        name: folder.name,
        description: folder.description ?? null,
        visibility,
        categoryId,
        externalId,
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
        slugify(folder.name, `folder-${folder.id}`),
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
  article: FreshdeskArticle,
  folderId: string,
  locale: Locale,
  translationGroupId?: string,
): Promise<{ id: string; translationGroupId: string }> {
  const externalId = externalIdFor(article.id, locale);

  // Freshdesk HTML is years of accumulated pastes from Word, other help desks
  // and hand-written markup, so it goes through the same sanitiser as anything
  // an agent writes. Sanitising at import rather than at render keeps the
  // stored row safe for every consumer.
  const bodyHtml = sanitiseArticleHtml(article.description ?? '');
  const bodyText = htmlToText(bodyHtml);

  const values = {
    title: article.title,
    bodyHtml,
    bodyText,
    excerpt: preview(bodyText, 200),
    folderId,
    locale,
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
    .select({ id: kbArticles.id, translationGroupId: kbArticles.translationGroupId })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.sourceSystem, 'freshdesk'),
        matchesExternalId(kbArticles.externalId, article.id, locale),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // The slug is deliberately not recomputed. It is the public URL, and a
    // title tweak in Freshdesk between rehearsal and cutover must not silently
    // move a page that is already linked to.
    await db
      .update(kbArticles)
      .set({
        ...values,
        externalId,
        ...(translationGroupId ? { translationGroupId } : {}),
      })
      .where(eq(kbArticles.id, existing[0].id));

    return {
      id: existing[0].id,
      translationGroupId: translationGroupId ?? existing[0].translationGroupId,
    };
  }

  const taken = await db
    .select({ slug: kbArticles.slug })
    .from(kbArticles)
    .where(eq(kbArticles.locale, locale));

  const inserted = await db
    .insert(kbArticles)
    .values({
      ...values,
      slug: uniqueSlug(
        slugify(article.title, `article-${article.id}`),
        taken.map((row) => row.slug),
      ),
      // Freshdesk's folder visibility is the real gate; an article inherits it,
      // and the folder check on the public side enforces it again.
      visibility: 'public',
      ...(translationGroupId ? { translationGroupId } : {}),
      sourceSystem: 'freshdesk',
      externalId,
    })
    .returning({ id: kbArticles.id, translationGroupId: kbArticles.translationGroupId });

  return inserted[0]!;
}

/**
 * Redirects for every URL shape a Freshdesk account can serve.
 *
 * Written for the primary-language article only: the legacy paths carry no
 * language, and the article page offers a language switcher. The article's
 * external id also resolves these at request time, so these rows are belt to
 * that brace.
 */
async function writeRedirects(freshdeskId: number, articleId: string): Promise<void> {
  const paths = [
    `/support/solutions/articles/${freshdeskId}`,
    `/solutions/articles/${freshdeskId}`,
    `/a/solutions/articles/${freshdeskId}`,
  ];

  for (const fromPath of paths) {
    await db
      .insert(kbRedirects)
      .values({ fromPath, articleId })
      .onConflictDoUpdate({ target: kbRedirects.fromPath, set: { articleId } });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
