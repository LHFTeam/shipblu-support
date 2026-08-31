import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbFolders, kbMedia } from '@/db/schema';
import { kbViewer } from '@/lib/kb/viewer';
import { articleVisibleTo, folderVisibleTo } from '@/lib/kb/visibility';
import { downloadObject } from '@/lib/storage';

/**
 * Serves a knowledge base image from our own storage.
 *
 * These used to be `<img src>`s pointing at Freshdesk's CDN. The bytes are ours
 * now, and this is the URL that appears in `body_html` in their place — which
 * is why it is a route rather than a signed URL: an article's pictures have to
 * keep working for as long as the article does, and a signed URL expires in
 * minutes.
 *
 * Under `/api/kb`, which `proxy.ts` already lists in `PUBLIC_PREFIXES`, so a
 * reader with no session gets the image rather than a redirect to /login.
 */

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A year, immutable.
 *
 * Safe because the URL is the media row's id and the object it addresses is
 * content-addressed by source URL: a different picture is a different row and a
 * different URL, so nothing a reader has cached can ever go stale.
 */
const PUBLIC_CACHE = 'public, max-age=31536000, immutable';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return new NextResponse(null, { status: 404 });

  const rows = await db
    .select({
      storagePath: kbMedia.storagePath,
      contentType: kbMedia.contentType,
      status: kbArticles.status,
      articleVisibility: kbArticles.visibility,
      folderVisibility: kbFolders.visibility,
    })
    .from(kbMedia)
    .innerJoin(kbArticles, eq(kbArticles.id, kbMedia.articleId))
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(eq(kbMedia.id, id))
    .limit(1);

  const media = rows[0];
  if (!media) return new NextResponse(null, { status: 404 });

  // The cheap path, and the only one that may be cached by anything shared: an
  // image inside a published public article in a public folder is public to
  // everybody, so the answer does not depend on who is asking and the session
  // is never read. Every other case is decided by the viewer below, and a
  // viewer-dependent response must never carry `public` in Cache-Control — one
  // shared cache entry is how a gated screenshot reaches the wrong reader.
  const isPublic =
    media.status === 'published' &&
    media.articleVisibility === 'public' &&
    media.folderVisibility === 'public';

  if (!isPublic) {
    const viewer = await kbViewer();

    // Re-asked through the same predicates the help centre's own queries use,
    // rather than re-deciding the rule here. `agents_only` matches no branch in
    // either of them, so an internal article's screenshots are unreachable from
    // this route whoever is signed in.
    const allowed = await db
      .select({ id: kbMedia.id })
      .from(kbMedia)
      .innerJoin(kbArticles, eq(kbArticles.id, kbMedia.articleId))
      .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
      .where(and(eq(kbMedia.id, id), articleVisibleTo(viewer), folderVisibleTo(viewer)))
      .limit(1);

    // 404 rather than 403: a 403 confirms the image exists, which is the one
    // fact the gate is there to withhold.
    if (!allowed[0]) return new NextResponse(null, { status: 404 });
  }

  let object: { content: Buffer; contentType: string };
  try {
    object = await downloadObject(media.storagePath);
  } catch (error) {
    // The row says the object is there and it is not. Worth a log line, because
    // it means the bucket and the table have drifted apart.
    console.error(`[kb-media] ${id} → ${media.storagePath} unreadable: ${error}`);
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(new Uint8Array(object.content), {
    headers: {
      // The stored type, not the one the object store reports back: the row is
      // what the upload checked against the image allowlist.
      'Content-Type': media.contentType,
      'Content-Length': String(object.content.length),
      'Cache-Control': isPublic ? PUBLIC_CACHE : 'private, no-store',
      // Belt and braces on a route that returns bytes a third party once
      // supplied: never let a browser talk itself into a different type.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
