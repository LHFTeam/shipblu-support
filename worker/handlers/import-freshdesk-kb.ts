import { and, eq, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { env } from '@/lib/env';
import {
  discoverLanguageCode,
  FreshdeskError,
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
import { normaliseArticleHtml } from '@/lib/kb/format';
import { detectCategoryLocale, detectLocale, looksUntranslated } from '@/lib/kb/language';
import { LOCALES, LOCALE_NAMES, type Locale } from '@/lib/kb/locale';
import { slugify, uniqueSlug } from '@/lib/kb/slug';
import { errorMessage } from '@/lib/errors';

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
 *
 * The primary tree is read in full before anything is written, because the
 * language codes are discovered from it and a code cannot be trusted to the
 * first category alone — see `discoverLanguageCode`.
 */

/**
 * How many items to probe when working out a language code.
 *
 * More than one, because a single untranslated item hid an entire language
 * before; bounded, because on a large account this is otherwise a crawl of
 * everything before the import proper has started.
 */
const PROBE_CATEGORIES = 10;
const PROBE_ARTICLES = 10;

/** One category's primary-language contents, read before anything is written. */
type Branch = {
  category: FreshdeskCategory;
  contents: { folder: FreshdeskFolder; articles: FreshdeskArticle[] }[];
};

/** What the primary pass made of a branch, needed again by the translations. */
type Imported = {
  primaryLocale: Locale;
  categoryTranslationGroupId: string;
  /** Freshdesk article id → translation group, so a translation joins its original. */
  articleGroups: Map<number, string>;
};

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
  /*
    One item's failure is recorded and the run carries on — except when
    Freshdesk did not answer at all. Every request left would then wait out its
    own fifteen-second deadline, over an hour for a few hundred articles,
    holding the worker's whole batch and outliving the reclaim window, so a
    deploy could start a second import beside it. Thrown instead, the job fails
    now and the queue retries the run later: the import is idempotent on
    `(source_system, external_id)`, so running it again repairs rather than
    duplicates.
  */
  const record = (what: string, error: unknown) => {
    if (error instanceof FreshdeskError && error.status === 0) throw error;
    failures.push(`${what}: ${errorMessage(error)}`);
  };
  let categoryCount = 0;
  let folderCount = 0;
  const articlesByLocale = new Map<Locale, number>(LOCALES.map((locale) => [locale, 0]));
  /** Translations that carry the original text unchanged — see `looksUntranslated`. */
  const untranslated: string[] = [];

  const categories = await listCategories();
  if (categories.length === 0) {
    console.warn('[import_freshdesk_kb] Freshdesk returned no categories');
    return;
  }

  // --- read the primary tree ------------------------------------------------

  const tree: Branch[] = [];

  for (const category of categories) {
    try {
      const folders = await listFolders(category.id);
      const contents: Branch['contents'] = [];

      for (const folder of folders) {
        try {
          contents.push({ folder, articles: await listArticles(folder.id) });
        } catch (error) {
          record(`folder ${folder.id}`, error);
        }
      }

      tree.push({ category, contents });
    } catch (error) {
      record(`category ${category.id}`, error);
    }
  }

  // --- write the primary language -------------------------------------------

  const imported = new Map<number, Imported>();

  for (const { category, contents } of tree) {
    try {
      // The category's locale is decided by its articles, and every article
      // inherits it, so it has to be settled before the first write.
      const samples = contents.flatMap(({ articles }) =>
        articles.map((article) => ({
          article,
          sample: `${article.title} ${article.description_text ?? ''}`,
        })),
      );

      const { locale: primaryLocale } = detectCategoryLocale(
        category.name,
        samples.map(({ sample }) => sample),
      );

      const odd = samples.filter(({ sample }) => detectLocale(sample) !== primaryLocale);

      if (odd.length > 0) {
        // Named, not counted. This warning used to report "1 of 47 article(s)
        // look like the other language", which reads as a filing mistake and
        // sent someone hunting for an article to move. The one it was pointing
        // at was in the right category and had simply never been translated —
        // Arabic title, English body. Both explanations are real and they need
        // opposite actions, so name the articles and let a person look.
        console.warn(
          `[import_freshdesk_kb] category "${category.name}" imported as ${primaryLocale}, but ` +
            `${odd.length} of ${samples.length} article(s) are written in the other language: ` +
            `${odd
              .slice(0, 5)
              .map(({ article }) => `${article.id} "${article.title}"`)
              .join(', ')}${odd.length > 5 ? ', …' : ''}. Either they are filed under the wrong ` +
            `category in Freshdesk, or their translation was never written — the summary below ` +
            `counts the second kind.`,
        );
      }

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
              count(articlesByLocale, primaryLocale);
            } catch (error) {
              record(`article ${article.id}`, error);
            }
          }
        } catch (error) {
          record(`folder ${folder.id}`, error);
        }
      }

      imported.set(category.id, {
        primaryLocale,
        categoryTranslationGroupId: primaryCategory.translationGroupId,
        articleGroups,
      });
    } catch (error) {
      record(`category ${category.id}`, error);
    }
  }

  // --- work out which code this account uses for each language --------------

  const probe = {
    categoryIds: tree.map(({ category }) => category.id).slice(0, PROBE_CATEGORIES),
    articleIds: tree
      .flatMap(({ contents }) => contents.flatMap(({ articles }) => articles.map((a) => a.id)))
      .slice(0, PROBE_ARTICLES),
  };

  const codes = new Map<Locale, string>();
  for (const locale of LOCALES) {
    const code = await discoverLanguageCode(locale, probe);
    if (code) codes.set(locale, code);
  }

  console.log(
    `[import_freshdesk_kb] language codes: ${LOCALES.map(
      (locale) => `${locale}=${codes.get(locale) ?? 'not found'}`,
    ).join(
      ', ',
    )} (probed ${probe.categoryIds.length} categories, ${probe.articleIds.length} articles)`,
  );

  // A language nobody publishes in is a legitimate answer, but so is a wrong
  // code, and the two look identical from here. Say which languages produced
  // nothing rather than reporting a clean run — that silence is what let an
  // account's whole English tree go missing without anyone noticing.
  for (const locale of LOCALES) {
    if (codes.has(locale)) continue;
    console.warn(
      `[import_freshdesk_kb] no ${LOCALE_NAMES[locale]} content found. Either the Freshdesk ` +
        `account publishes nothing in it, or its language code is not one this import knows ` +
        `for ${locale}.`,
    );
  }

  // --- write every other language ------------------------------------------

  for (const { category, contents } of tree) {
    const state = imported.get(category.id);
    if (!state) continue;

    for (const [locale, code] of codes) {
      if (locale === state.primaryLocale) continue;

      try {
        // Containers are created from the first translated article found beneath
        // them, rather than up front. Two reasons, both learned the hard way: a
        // branch with nothing translated must not leave an empty category behind
        // in a language it has no content in, and a category whose own name was
        // never translated must not take its articles down with it — Freshdesk
        // lets you translate an article and leave its category alone, and
        // dropping the branch on that basis lost every article under it.
        let categoryRow: { id: string; translationGroupId: string } | null = null;

        for (const { folder, articles } of contents) {
          let folderRowId: string | null = null;

          for (const article of articles) {
            try {
              const translatedArticle = await getTranslatedArticle(article.id, code);
              if (!translatedArticle) continue;

              if (!categoryRow) {
                const translatedCategory = await getTranslatedCategory(category.id, code);
                if (!translatedCategory) {
                  console.warn(
                    `[import_freshdesk_kb] category "${category.name}" has ${locale} articles but ` +
                      `no ${locale} name; keeping the original name for it`,
                  );
                }

                categoryRow = await upsertCategory(
                  { ...(translatedCategory ?? category), id: category.id },
                  locale,
                  state.categoryTranslationGroupId,
                );
                categoryCount += 1;
              }

              if (!folderRowId) {
                const translatedFolder = await getTranslatedFolder(folder.id, code);

                folderRowId = await upsertFolder(
                  {
                    ...(translatedFolder ?? folder),
                    id: folder.id,
                    // Visibility comes from the primary folder: it is an access
                    // rule, not translated content, and a translation that
                    // omitted it would silently widen who can see the articles.
                    visibility: folder.visibility,
                  },
                  categoryRow.id,
                  locale,
                );
                folderCount += 1;
              }

              if (looksUntranslated(article.description_text, translatedArticle.description_text)) {
                // Imported anyway. It is a real record in Freshdesk, an agent
                // searching for it should find it, and removing it would take
                // the article out of this language's listings on the strength of
                // a guess about someone's intent. Reported so the gap is
                // someone's decision rather than a silent half-translation.
                untranslated.push(`${article.id} "${article.title}"`);
              }

              await upsertArticle(
                { ...translatedArticle, id: article.id, status: article.status },
                folderRowId,
                locale,
                state.articleGroups.get(article.id),
              );
              count(articlesByLocale, locale);
            } catch (error) {
              record(`article ${article.id} (${locale})`, error);
            }
          }
        }
      } catch (error) {
        record(`category ${category.id} (${locale})`, error);
      }
    }
  }

  console.log(
    `[import_freshdesk_kb] ${categoryCount} categories, ${folderCount} folders, ` +
      `${LOCALES.map((locale) => `${articlesByLocale.get(locale) ?? 0} ${locale}`).join(', ')} ` +
      `articles in ${Math.round((Date.now() - started) / 1000)}s` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );

  if (untranslated.length) {
    console.warn(
      `[import_freshdesk_kb] ${untranslated.length} translated article(s) carry the original text ` +
        `unchanged, so they read in the wrong language: ${untranslated.slice(0, 10).join(', ')}` +
        `${untranslated.length > 10 ? ', …' : ''}. Translating the body in Freshdesk is the fix; ` +
        `the next import will pick it up.`,
    );
  }

  if (failures.length) {
    for (const failure of failures.slice(0, 20)) {
      console.error(`[import_freshdesk_kb] ${failure}`);
    }
    throw new Error(`${failures.length} item(s) failed to import`);
  }
}

function count(counts: Map<Locale, number>, locale: Locale): void {
  counts.set(locale, (counts.get(locale) ?? 0) + 1);
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
  //
  // And then through the same normaliser, for the reason the first import made
  // plain: what arrived carried four editors' classes, inline colours a dark
  // theme cannot survive, and 128 body `h1`s the help centre's stylesheet does
  // not dress. Re-importing without this would undo the cleanup article by
  // article — `lib/kb/format.ts` has the standard and the evidence for it.
  const bodyHtml = normaliseArticleHtml(sanitiseArticleHtml(article.description ?? ''));
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
