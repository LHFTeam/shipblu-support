import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { isUuid } from '@/lib/http/uuid';
import { KB_IMAGE_REDIRECT_MAX_AGE, rememberedKbImageUrl, signKbImageUrl } from '@/lib/kb/images';

export const dynamic = 'force-dynamic';

/**
 * Redirects to a signed URL for one of the knowledge base's pictures.
 *
 * Public, and on purpose: these are the pictures in public articles, drawn on
 * the help centre, in the widget's article panel and in the console, and an
 * article names one by this path (`kbImageSrc`). `/api/kb` is already in
 * `PUBLIC_PREFIXES`, and `/api` passes through on the help centre's own host,
 * so the same relative path loads everywhere the article does.
 *
 * A redirect rather than the bytes, as `/api/attachments/[id]` does: the
 * bucket is private because it also holds customers' files, and making it
 * public for these would make every object key the only thing between a
 * stranger and an invoice. Unlike an attachment's, the signature here is long
 * and reused, and the redirect itself may be cached for an hour, by anybody,
 * because the picture is public and an id never names different bytes
 * (`lib/kb/images.ts` says how the two lifetimes fit).
 *
 * An id this does not hold answers as a picture that does not exist.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Postgres raises 22P02 on a malformed uuid; a broken `<img>` deserves a 404.
  if (!isUuid(id)) return notFound();
  const key = id.toLowerCase();
  const now = Date.now();

  let url = rememberedKbImageUrl(key, now);
  if (!url) {
    // Only a miss costs anything — a query and a Storage signature — so only
    // a miss is limited. Per address and generous, for the reason the widget's
    // file route gives: whole neighbourhoods share one address in Egypt, and
    // one article page asks for up to fifteen pictures at once.
    if (!allow(`kb-image:${clientIp(request)}`, 600, 60_000)) {
      return NextResponse.json({ error: 'slow down' }, { status: 429 });
    }
    url = await signKbImageUrl(key, now);
    if (!url) return notFound();
  }

  const response = NextResponse.redirect(url, { status: 307 });
  response.headers.set('Cache-Control', `public, max-age=${KB_IMAGE_REDIRECT_MAX_AGE}`);
  return response;
}

function notFound() {
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}
