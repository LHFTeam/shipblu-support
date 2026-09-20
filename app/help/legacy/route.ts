import { NextResponse } from 'next/server';
import { and, eq, like, or } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbFolders } from '@/db/schema';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { findRedirect } from '@/lib/kb/queries';
import { freshdeskArticleId } from '@/lib/kb/slug';
import { redirectTo } from '@/lib/http/redirect';

export const dynamic = 'force-dynamic';

/**
 * Resolves a Freshdesk URL to its new home.
 *
 * The proxy cannot do this itself — it runs on the Edge runtime with no
 * database — so it rewrites here and this does the lookup. Two strategies, in
 * order: an explicit `kb_redirects` row (which the importer writes, and which
 * an admin can add by hand), then the article's Freshdesk id recorded in
 * `external_id` at import.
 *
 * The second is what makes this work without a redirect row per article: the
 * importer already stores every article's Freshdesk id, so the mapping exists
 * whether or not anyone remembered to write a redirect.
 */
export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get('path') ?? '';

  const explicit = await findRedirect(path);
  if (explicit) return permanent(explicit);

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
      .select({ slug: kbArticles.slug, locale: kbArticles.locale })
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

    const article =
      rows.find((row) => row.locale === preferred) ??
      rows.find((row) => row.locale === DEFAULT_LOCALE) ??
      rows[0];

    if (article) return permanent(`/${article.locale}/a/${article.slug}`);
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
    if (byFolder[0]) return permanent(`/${DEFAULT_LOCALE}`);
  }

  // Genuinely unknown. A 404 here is correct — redirecting every unmatched URL
  // to the home page is a well-known way to make a site unsearchable.
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

/**
 * 301 rather than 302: these URLs are never coming back, and a permanent
 * redirect is what transfers the old page's search ranking to the new one.
 *
 * That permanence is also why the relative `Location` matters more here than
 * anywhere else: a browser caches a 301 indefinitely, so the internal listen
 * address `new URL(to, request.url)` used to produce would have been
 * remembered per visitor rather than merely failing once.
 */
function permanent(to: string): NextResponse {
  return redirectTo(to, 301);
}
