import { NextResponse } from 'next/server';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { canonicalUuid } from '@/lib/http/uuid';
import { mayReadRestrictedImage } from '@/lib/kb/image-access';
import {
  KB_IMAGE_REDIRECT_MAX_AGE,
  KB_IMAGE_RESTRICTED_MAX_AGE,
  kbImageFor,
  rememberedPublicKbImageUrl,
  signPublicKbImageUrl,
  signRestrictedKbImageUrl,
} from '@/lib/kb/images';
import { logger } from '@/lib/log';

export const dynamic = 'force-dynamic';

const log = logger('kb_images');

/**
 * Redirects to a signed URL for one of the knowledge base's pictures, for
 * whoever may read an article that shows it.
 *
 * An article names a picture by this path (`kbImageSrc`). `/api/kb` is in
 * `PUBLIC_PREFIXES`, and `/api` passes through on the help centre's own host,
 * so the same relative path loads everywhere the article does: the help
 * centre, the widget's article panel and the console.
 *
 * A redirect rather than the bytes, as `/api/attachments/[id]` does: the
 * bucket is private because it also holds customers' files. Who gets the
 * redirect depends on the articles that show the picture
 * (`lib/kb/images.ts`):
 *
 * - **Public**, shown by a published article a stranger can read: anybody,
 *   with a long signature reused across readers, and a redirect anybody may
 *   cache for an hour.
 * - **Restricted**, anything else: a console agent, or a signed-in customer an
 *   article visible to them shows it (`mayReadRestrictedImage`), with a
 *   five-minute signature and a redirect only their browser may keep.
 *
 * A picture somebody may not see answers as one that does not exist, and so
 * does a malformed id. Neither may be cached, since the same id can answer
 * differently to the next reader. A Storage failure is logged and answered
 * 502, uncached, so neither a browser nor a cache holds on to it.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Postgres raises 22P02 on a malformed uuid; a broken `<img>` deserves a 404.
  const key = canonicalUuid(id);
  if (!key) return notFound();
  const now = Date.now();

  const remembered = rememberedPublicKbImageUrl(key, now);
  if (remembered) return redirect(remembered, `public, max-age=${KB_IMAGE_REDIRECT_MAX_AGE}`);

  // Only a miss costs anything — queries and a Storage signature — so only a
  // miss is limited. Per address and generous, for the reason the widget's
  // file route gives: whole neighbourhoods share one address in Egypt, and one
  // article page asks for up to fifteen pictures at once.
  if (!allow(`kb-image:${clientIp(request)}`, 600, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  try {
    const image = await kbImageFor(key);
    if (!image) return notFound();

    if (image.shownPublicly) {
      const url = await signPublicKbImageUrl(key, image.storagePath, now);
      return redirect(url, `public, max-age=${KB_IMAGE_REDIRECT_MAX_AGE}`);
    }

    if (!(await mayReadRestrictedImage(key))) return notFound();
    const url = await signRestrictedKbImageUrl(image.storagePath);
    return redirect(url, `private, max-age=${KB_IMAGE_RESTRICTED_MAX_AGE}`);
  } catch (error) {
    log.error(`could not serve picture ${key}`, error);
    return NextResponse.json(
      { error: 'unavailable' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

function redirect(url: string, cacheControl: string) {
  const response = NextResponse.redirect(url, { status: 307 });
  response.headers.set('Cache-Control', cacheControl);
  return response;
}

function notFound() {
  return NextResponse.json(
    { error: 'not found' },
    { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
