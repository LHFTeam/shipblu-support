import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbFolders, kbRedirects } from '@/db/schema';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { freshdeskArticleId } from '@/lib/kb/slug';

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

  const explicit = await db
    .select({
      toPath: kbRedirects.toPath,
      slug: kbArticles.slug,
      locale: kbArticles.locale,
    })
    .from(kbRedirects)
    .leftJoin(kbArticles, eq(kbArticles.id, kbRedirects.articleId))
    .where(eq(kbRedirects.fromPath, path))
    .limit(1);

  const row = explicit[0];
  if (row?.slug) return permanent(request, `/${row.locale}/a/${row.slug}`);
  if (row?.toPath) return permanent(request, row.toPath);

  const freshdeskId = freshdeskArticleId(path);
  if (freshdeskId) {
    const byExternalId = await db
      .select({ slug: kbArticles.slug, locale: kbArticles.locale })
      .from(kbArticles)
      .where(and(eq(kbArticles.sourceSystem, 'freshdesk'), eq(kbArticles.externalId, freshdeskId)))
      .limit(1);

    const article = byExternalId[0];
    if (article) return permanent(request, `/${article.locale}/a/${article.slug}`);
  }

  const folderId = /\/solutions\/folders\/(\d+)/.exec(path)?.[1];
  if (folderId) {
    const byFolder = await db
      .select({ slug: kbFolders.slug })
      .from(kbFolders)
      .where(and(eq(kbFolders.sourceSystem, 'freshdesk'), eq(kbFolders.externalId, folderId)))
      .limit(1);

    // Folder URLs need their category to be addressable, and a folder that
    // moved category since import would send the reader somewhere wrong. The
    // help centre home is a worse answer than the right folder but a better
    // one than a 404.
    if (byFolder[0]) return permanent(request, `/${DEFAULT_LOCALE}`);
  }

  // Genuinely unknown. A 404 here is correct — redirecting every unmatched URL
  // to the home page is a well-known way to make a site unsearchable.
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

/**
 * 301 rather than 302: these URLs are never coming back, and a permanent
 * redirect is what transfers the old page's search ranking to the new one.
 */
function permanent(request: Request, to: string): NextResponse {
  return NextResponse.redirect(new URL(to, request.url), { status: 301 });
}
