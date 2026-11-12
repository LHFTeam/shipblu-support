import { and, asc, eq, like, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { articlePath, legacyArticleIndex, legacyArticleResolver } from './format';
import { freshdeskCategoryId, freshdeskFolderId, portalLanguage } from './legacy-path';
import { DEFAULT_LOCALE, isLocale } from './locale';
import { findRedirect } from './queries';
import { freshdeskArticleId } from './slug';
import { someReaderMayOpen } from './visibility';

/**
 * Where a legacy URL sends its reader, and whether for good.
 *
 * `permanent` is false when the answer stands in for an article, a folder or a
 * category closed for now (a draft, archived, agents-only): the translation answered is
 * not the one the URL, or its `kb_redirects` row, names. A 301 there is kept by the browser and
 * moves the old URL's standing in search to the stand-in, so once the article
 * reopens its readers would still land on the other one. A 302 serves them
 * meanwhile and pins nothing.
 */
export type LegacyAnswer = { to: string; permanent: boolean };

/**
 * Where a Freshdesk URL's reader goes now: a help-centre path, or null when
 * nothing here answers for it.
 *
 * `app/help/legacy/route.ts` answers with this, and the proxy hands that
 * route every Freshdesk shape it recognises (`./legacy-path.ts`). Here rather
 * than in the route so a database test reaches it without building a request.
 *
 * Four strategies, in order. First, an explicit `kb_redirects` row, which the
 * importer writes and an admin can add by hand. Then the article's Freshdesk id
 * recorded in `external_id` at import. Then a folder, to its own page
 * (`resolveFolder`). Last, a category, to its own page (`resolveCategory`). The
 * id lookups are what make this work without a redirect row per URL: the
 * importer stores every article's, folder's and category's Freshdesk id, so
 * the mapping exists whether or not anybody remembered to write a redirect.
 *
 * Only an article, a folder or a category some reader can open answers
 * (`someReaderMayOpen`), and the answer is permanent only when it is the one
 * this would give were every one open (`LegacyAnswer`).
 */
export async function resolveLegacyPath(path: string): Promise<LegacyAnswer | null> {
  // A bare hit — a crawler, a scanner, a direct call with nothing in it — can
  // only miss, so it costs no query.
  if (!path) return null;

  const explicit = (await findRedirect(path)) ?? (await titledRedirect(path));
  if (explicit?.to) return { to: explicit.to, permanent: explicit.to === explicit.ideal };

  const freshdeskId = freshdeskArticleId(path);
  if (freshdeskId) {
    // External ids are scoped by language — "72000123456:ar" — because one
    // Freshdesk article becomes one row per language here. The legacy path
    // carries no language, so this matches any of them.
    //
    // Freshdesk does put a language in the portal URL (`/en/support/...`), so
    // that is preferred when present; otherwise the default locale wins, and
    // failing that whichever translation exists. The article page carries a
    // language switcher either way, so a reader who lands on the wrong one is
    // one click from the right one rather than at a dead end.
    const preferred = portalLanguage(path);

    const rows = await db
      .select({
        slug: kbArticles.slug,
        locale: kbArticles.locale,
        externalId: kbArticles.externalId,
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        folderVisibility: kbFolders.visibility,
      })
      .from(kbArticles)
      .leftJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
      .where(
        and(
          eq(kbArticles.sourceSystem, 'freshdesk'),
          or(
            eq(kbArticles.externalId, freshdeskId),
            like(kbArticles.externalId, `${freshdeskId}:%`),
          ),
        ),
      );

    // Chosen in the order every writer of a body points a link at a
    // translation (`legacyArticleResolver`, which with the default locale as
    // the article's own is the order above), from the translations a reader
    // can open. A closed one would be a redirect to a page that 404s, where
    // another translation answers.
    const choose = (translations: typeof rows) => {
      const article = legacyArticleResolver(legacyArticleIndex(translations), DEFAULT_LOCALE)(
        freshdeskId,
        preferred,
      );
      return article ? articlePath(article.locale, article.slug) : null;
    };

    const to = choose(rows.filter(someReaderMayOpen));
    if (to) {
      // The same choice were every translation open, unless the row named one.
      const ideal =
        explicit?.ideal ?? choose(rows.map((row) => ({ ...row, status: 'published' as const })));
      return { to, permanent: to === ideal };
    }
  }

  const folderId = freshdeskFolderId(path);
  if (folderId) return resolveFolder(folderId, portalLanguage(path), explicit?.ideal);

  const categoryId = freshdeskCategoryId(path);
  if (categoryId) return resolveCategory(categoryId, portalLanguage(path), explicit?.ideal);

  return null;
}

/**
 * Where a Freshdesk category URL's reader goes: the category's own page,
 * `/<locale>/c/<slug>`, or null.
 *
 * The importer kept Freshdesk's category ids as it kept the articles' —
 * `kb_categories.external_id` is `<id>:<locale>`, one row per translation — so
 * the page is found by id. Its translation is chosen as an article's is: the
 * language the URL names, then the default locale, then whichever translation
 * answers. Render's log for `support.shipblu.com` showed the two public
 * categories' URLs followed 8 times in the night after the move, real browsers
 * among them, each answered with the help centre's 404.
 *
 * **Only a category some reader can open answers**, which is a question about
 * what is inside it: a category has no visibility of its own, and its page
 * (`getCategory`) is a 404 for anybody who can read none of its articles in its
 * language. So a translation answers when it holds an article in its own
 * language that `someReaderMayOpen` passes — published, and neither it nor its
 * folder agents-only — and a translation whose readable articles are all in
 * another language is a page that 404s, as `getCategory`'s locale filter makes
 * it. A locale the help centre does not have is never one.
 *
 * **A category nobody can open answers null, so the route's 404**, not the home.
 * The internal employee guide (`154000297102` in production, Arabic only, all
 * four folders agents-only) is the case, and four things decide it:
 *
 *  - It is what this function already answers for an article no reader can
 *    open: production's four internal articles' old URLs answer 404, not the
 *    home (`plans/freshdesk-disconnection.md`, PR 3).
 *  - It is what the category's own page answers. `/ar/c/دليل-الموظف` is a 404
 *    for every reader, so the Freshdesk URL answering anything more would say
 *    more than the page it names.
 *  - It answers exactly as an id nothing was imported as does, so the response
 *    does not confirm that an internal category exists under that id. A
 *    redirect home for it alone would.
 *  - The home holds nothing of the guide, so it would be a soft 404: a search
 *    engine reads a redirect to the home as one, and a reader is left looking
 *    for something that is not there. The guide's readers are agents, and
 *    their copy is in the console's knowledge base, which this public route
 *    must not point at.
 *
 * The 301 follows `LegacyAnswer`: only when the translation answered is the one
 * this would choose were every translation open (or a `kb_redirects` row for
 * the URL names one, `named`). A URL asking for English while the English
 * category is closed for now gets the Arabic one with a 302, which no browser
 * keeps once the English one opens again.
 */
async function resolveCategory(
  freshdeskId: string,
  preferred: string | undefined,
  named: string | undefined,
): Promise<LegacyAnswer | null> {
  // Each translation with what its articles in its own language let a reader
  // do. Distinct, because a category holds dozens of articles that differ in
  // nothing asked here; ordered, so "whichever translation answers" is the same
  // one on every request.
  const rows = await db
    .selectDistinct({
      slug: kbCategories.slug,
      locale: kbCategories.locale,
      status: kbArticles.status,
      visibility: kbArticles.visibility,
      folderVisibility: kbFolders.visibility,
    })
    .from(kbCategories)
    .leftJoin(kbFolders, eq(kbFolders.categoryId, kbCategories.id))
    .leftJoin(
      kbArticles,
      and(eq(kbArticles.folderId, kbFolders.id), eq(kbArticles.locale, kbCategories.locale)),
    )
    .where(
      and(
        eq(kbCategories.sourceSystem, 'freshdesk'),
        or(
          eq(kbCategories.externalId, freshdeskId),
          like(kbCategories.externalId, `${freshdeskId}:%`),
        ),
      ),
    )
    .orderBy(asc(kbCategories.locale), asc(kbCategories.slug));

  return translationAnswer(rows, (row) => `/${row.locale}/c/${row.slug}`, preferred, named);
}

/**
 * Where a Freshdesk folder URL's reader goes: the folder's own page,
 * `/<locale>/c/<category slug>/<folder slug>`, or null.
 *
 * The importer kept Freshdesk's folder ids as it kept the categories'
 * (`kb_folders.external_id` is `<id>:<locale>`, one row per translation). A
 * folder has no language or path of its own: its page is under its category,
 * whose language is the page's and whose slug comes before the folder's, so
 * each translation is read with its category as it stands now, and a folder
 * moved to another category since the import answers at the page it has there.
 * The translation is chosen as a category's is (`translationAnswer`).
 *
 * **Only a folder some reader can open answers**: not agents-only, and holding
 * an article in its category's language that `someReaderMayOpen` passes. Both
 * halves are what `getFolder` reads, the folder's own visibility and the
 * articles it lists in the page's language. `getFolder` opens a folder that
 * lists none, with a line saying it is empty; this sends nobody there, because
 * a 301 to a page with nothing on it is a soft 404 that the browser keeps. So
 * such a folder answers null, as a category with nothing to list does, whose
 * page is a 404 (`getCategory`).
 *
 * **A folder nobody can open answers null, so the route's 404**, exactly as an
 * id nothing was imported under does. The employee guide's four agents-only
 * folders are the case, for the reasons `resolveCategory` gives for the guide
 * itself: it is what their own pages answer for every reader, and what the
 * route answers for the articles inside them; and a redirect for these ids
 * alone would confirm that an internal folder exists under each. Every
 * imported folder answered a 301 to the home until the category rule's change
 * refused these four. The others still did until this, which pinned the home
 * in browsers and search indexes where the folder's own page could answer.
 *
 * The 301 follows `LegacyAnswer`, as a category's does: only when the
 * translation answered is the one this would choose were every translation
 * open (or a `kb_redirects` row for the URL names one, `named`). A page of the
 * folder's list (`/page/2`) answers as the folder does (`freshdeskFolderId`).
 */
async function resolveFolder(
  freshdeskId: string,
  preferred: string | undefined,
  named: string | undefined,
): Promise<LegacyAnswer | null> {
  // Each translation with its category, and what its articles in the
  // category's language let a reader do. Distinct and ordered, as a category's.
  const rows = await db
    .selectDistinct({
      locale: kbCategories.locale,
      categorySlug: kbCategories.slug,
      folderSlug: kbFolders.slug,
      folderVisibility: kbFolders.visibility,
      status: kbArticles.status,
      visibility: kbArticles.visibility,
    })
    .from(kbFolders)
    .innerJoin(kbCategories, eq(kbCategories.id, kbFolders.categoryId))
    .leftJoin(
      kbArticles,
      and(eq(kbArticles.folderId, kbFolders.id), eq(kbArticles.locale, kbCategories.locale)),
    )
    .where(
      and(
        eq(kbFolders.sourceSystem, 'freshdesk'),
        or(eq(kbFolders.externalId, freshdeskId), like(kbFolders.externalId, `${freshdeskId}:%`)),
      ),
    )
    .orderBy(asc(kbCategories.locale), asc(kbCategories.slug), asc(kbFolders.slug));

  return translationAnswer(
    rows,
    (row) => `/${row.locale}/c/${row.categorySlug}/${row.folderSlug}`,
    preferred,
    named,
  );
}

/**
 * The answer for a Freshdesk category's or folder's URL, from its translations
 * here: `rows` holds one per translation and per kind of article it holds in
 * its own language, in an order that makes "whichever translation answers"
 * the same one on every request, and `pageOf` names a translation's page.
 *
 * The translation is the one in the language the URL names, then the default
 * locale, then the first in `rows` that answers: the order an article's is
 * chosen in. One answers when `someReaderMayOpen` passes one of its rows, and a
 * locale the help centre does not have never does. The answer is permanent
 * when it is the page this would choose were every translation open, or the
 * one `named` when a `kb_redirects` row for the URL names one (`LegacyAnswer`).
 */
function translationAnswer<
  Row extends Parameters<typeof someReaderMayOpen>[0] & { locale: string },
>(
  rows: readonly Row[],
  pageOf: (row: Row) => string,
  preferred: string | undefined,
  named: string | undefined,
): LegacyAnswer | null {
  // The page of the first translation, in the order above, among those `open`
  // passes for some article.
  const choose = (open: (row: Row) => boolean): string | null => {
    const pages = new Map<string, string>();
    for (const row of rows) {
      if (isLocale(row.locale) && open(row) && !pages.has(row.locale)) {
        pages.set(row.locale, pageOf(row));
      }
    }
    const locale = [preferred, DEFAULT_LOCALE, ...pages.keys()].find(
      (candidate) => candidate !== undefined && pages.has(candidate),
    );
    return locale ? (pages.get(locale) ?? null) : null;
  };

  const to = choose(someReaderMayOpen);
  if (!to) return null;
  return { to, permanent: to === (named ?? choose(() => true)) };
}

/**
 * The redirect row for an article URL that carries its title after the id.
 *
 * The importer writes its rows for the bare shapes (`/support`, `/a` and plain
 * `/solutions/articles/<id>`), pointing at the article in Freshdesk's primary
 * language, and the portal's own links carry the title. Without this the bare
 * shapes took the row's language and the titled one fell through to the id
 * lookup's default, so one article answered in two languages depending on
 * whether its link carried a title. A path naming a language
 * (`/en/support/…`) matches no row either way, and keeps the language it
 * names.
 */
async function titledRedirect(path: string): ReturnType<typeof findRedirect> {
  const untitled = path.replace(/(\/solutions\/articles\/\d+)-[^/?#]*$/, '$1');
  return untitled === path ? null : findRedirect(untitled);
}
