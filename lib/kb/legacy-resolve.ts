import { and, eq, like, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbFolders } from '@/db/schema';
import { articlePath, legacyArticleIndex, legacyArticleResolver } from './format';
import { DEFAULT_LOCALE } from './locale';
import { findRedirect } from './queries';
import { freshdeskArticleId } from './slug';

/**
 * Where a Freshdesk URL's reader goes now: a help-centre path, or null when
 * nothing here answers for it.
 *
 * `app/help/legacy/route.ts` answers with this, and the proxy hands that
 * route every Freshdesk shape it recognises (`./legacy-path.ts`). Here rather
 * than in the route so a database test reaches it without building a request.
 *
 * Three strategies, in order. First, an explicit `kb_redirects` row, which the
 * importer writes and an admin can add by hand. Then the article's Freshdesk id
 * recorded in `external_id` at import. Last, a folder, to the help centre home.
 * The id lookup is what makes this work without a redirect row per article:
 * the importer stores every article's Freshdesk id, so the mapping exists
 * whether or not anybody remembered to write a redirect.
 */
export async function resolveLegacyPath(path: string): Promise<string | null> {
  // A bare hit — a crawler, a scanner, a direct call with nothing in it — can
  // only miss, so it costs no query.
  if (!path) return null;

  const explicit = (await findRedirect(path)) ?? (await titledRedirect(path));
  if (explicit) return explicit;

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
    const preferred = /^\/([a-z]{2})(-[A-Za-z]{2})?\//.exec(path)?.[1];

    const rows = await db
      .select({
        slug: kbArticles.slug,
        locale: kbArticles.locale,
        externalId: kbArticles.externalId,
        status: kbArticles.status,
      })
      .from(kbArticles)
      .where(
        and(
          eq(kbArticles.sourceSystem, 'freshdesk'),
          or(
            eq(kbArticles.externalId, freshdeskId),
            like(kbArticles.externalId, `${freshdeskId}:%`),
          ),
        ),
      );

    // Published translations only, chosen in the order every writer of a body
    // points a link at one (`legacyArticleResolver`, which with the default
    // locale as the article's own is the order above). A draft or an archived
    // translation would be a permanent redirect to a page that 404s, where
    // another translation answers.
    const article = legacyArticleResolver(legacyArticleIndex(rows), DEFAULT_LOCALE)(
      freshdeskId,
      preferred,
    );

    if (article) return articlePath(article.locale, article.slug);
  }

  const folderId = /\/solutions\/folders\/(\d+)/.exec(path)?.[1];
  if (folderId) {
    const byFolder = await db
      .select({ slug: kbFolders.slug })
      .from(kbFolders)
      .where(
        and(
          eq(kbFolders.sourceSystem, 'freshdesk'),
          or(eq(kbFolders.externalId, folderId), like(kbFolders.externalId, `${folderId}:%`)),
        ),
      )
      .limit(1);

    // Folder URLs need their category to be addressable, and a folder that
    // moved category since import would send the reader somewhere wrong. The
    // help centre home is a worse answer than the right folder but a better
    // one than a 404.
    if (byFolder[0]) return `/${DEFAULT_LOCALE}`;
  }

  return null;
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
async function titledRedirect(path: string): Promise<string | null> {
  const untitled = path.replace(/(\/solutions\/articles\/\d+)-[^/?#]*$/, '$1');
  return untitled === path ? null : findRedirect(untitled);
}
