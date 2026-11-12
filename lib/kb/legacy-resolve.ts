import { and, asc, eq, like, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { articlePath, legacyArticleIndex, legacyArticleResolver } from './format';
import { freshdeskCategoryId, portalLanguage } from './legacy-path';
import { DEFAULT_LOCALE, isLocale } from './locale';
import { findRedirect } from './queries';
import { freshdeskArticleId } from './slug';
import { someReaderMayOpen } from './visibility';

/**
 * Where a legacy URL sends its reader, and whether for good.
 *
 * `permanent` is false when the answer stands in for an article or a category
 * closed for now (a draft, archived, agents-only): the translation answered is
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
 * recorded in `external_id` at import. Then a folder some reader can open, to
 * the help centre home. Last, a category, to its own page (`resolveCategory`). The id lookups are
 * what make this work without a redirect row per URL: the importer stores
 * every article's and category's Freshdesk id, so the mapping exists whether
 * or not anybody remembered to write a redirect.
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

  const folderId = /\/solutions\/folders\/(\d+)/.exec(path)?.[1];
  if (folderId) {
    // What the folder's articles in its category's language let a reader do,
    // as `resolveCategory` asks it of a category.
    const byFolder = await db
      .selectDistinct({
        status: kbArticles.status,
        visibility: kbArticles.visibility,
        folderVisibility: kbFolders.visibility,
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
          or(eq(kbFolders.externalId, folderId), like(kbFolders.externalId, `${folderId}:%`)),
        ),
      );

    // The help centre home is a worse answer than the folder's own page but a
    // better one than a 404, for a folder somebody can open. One nobody can
    // open — the employee guide's four, agents-only — answers as an id nothing
    // was imported under does, for the reasons `resolveCategory` gives its
    // category: a redirect home for it alone would say an internal folder
    // exists under the id, and the home holds nothing of it.
    if (byFolder.some(someReaderMayOpen)) return { to: `/${DEFAULT_LOCALE}`, permanent: true };
  }

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

  // The page of the first translation, in the order above, among those `open`
  // passes for some article.
  const choose = (open: (row: (typeof rows)[number]) => boolean): string | null => {
    const slugs = new Map<string, string>();
    for (const row of rows) {
      if (isLocale(row.locale) && open(row) && !slugs.has(row.locale)) {
        slugs.set(row.locale, row.slug);
      }
    }
    const locale = [preferred, DEFAULT_LOCALE, ...slugs.keys()].find(
      (candidate) => candidate !== undefined && slugs.has(candidate),
    );
    return locale ? `/${locale}/c/${slugs.get(locale)}` : null;
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
