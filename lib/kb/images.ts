import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbFolders, kbImages } from '@/db/schema';
import { isTimeout, sizedTimeout } from '@/lib/http/deadline';
import { readBodyCapped } from '@/lib/http/read-capped';
import { logger } from '@/lib/log';
import { containing } from '@/lib/search/like';
import { removeObjects, signedUrl, uploadObject } from '@/lib/storage';
import { sniffWidgetFile } from '@/lib/widget/sniff';
import {
  fetchableFreshworksImage,
  imageSources,
  isFreshworksImage,
  kbImageSrc,
  rewriteImageSources,
} from './image-src';
import { ANONYMOUS, articleVisibleTo, folderVisibleTo, type KbViewer } from './visibility';

/**
 * The knowledge base's own pictures: copied in, stored, and handed out.
 *
 * An article names a picture by `/api/kb/images/<id>` (`./image-src.ts`), the
 * row says where its bytes are, and the route redirects to a signed URL for
 * them. The bucket is the attachments bucket, private, because it also holds
 * customers' invoices and ID documents.
 *
 * A picture is handed out to whoever may read an article that shows it, as the
 * article itself is. One that a published article a stranger can read shows is
 * public, so its signature is long and reused (`signPublicKbImageUrl`), and the
 * redirect may be cached by anybody. Any other — in an internal article, a
 * signed-in customer's article, a draft, or no article yet — is signed for five
 * minutes per request, and only once the route has checked the reader
 * (`lib/kb/image-access.ts`), with private caching.
 */

const log = logger('kb_images');

/**
 * The largest picture copied in. Production's largest of 207 is well under a
 * megabyte (28.8 MiB across all of them); this only bounds what a wrong URL
 * can cost the worker, and is enforced while reading, not after.
 */
const MAX_KB_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * The types an article may show, as read from the bytes, with the extension
 * the stored key takes.
 *
 * Raster images a browser draws everywhere. No SVG, which is a document that
 * runs its author's script; no HEIC, which only Safari draws; and nothing the
 * remote server merely *says* is an image, since what is stored here is served
 * back with this type.
 */
const KB_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** What the bytes are, if they are a picture an article may show. */
export function kbImageType(bytes: Uint8Array): { contentType: string; extension: string } | null {
  const sniffed = sniffWidgetFile(bytes, false);
  if (!sniffed) return null;
  const extension = KB_IMAGE_TYPES[sniffed.contentType];
  return extension ? { contentType: sniffed.contentType, extension } : null;
}

/** A download that did not produce a picture, said in words for the job's report. */
export class KbImageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbImageFetchError';
  }
}

/**
 * Downloads one Freshworks image, under a deadline and a size cap.
 *
 * Refuses an address `fetchableFreshworksImage` does not accept before asking
 * for anything, and **follows no redirect**: `redirect: 'manual'` hands back
 * the 3xx itself, which is refused by name. Following one, even to check where
 * it landed afterwards, would have the worker ask every host on the way — a
 * link-local metadata address or an internal service included — before any
 * check ran. None of production's 207 addresses redirects. Every failure is a
 * `KbImageFetchError` naming what went wrong; the job keeps the old address and
 * reports it.
 */
export async function downloadFreshworksImage(
  url: string,
): Promise<{ content: Buffer; contentType: string; extension: string }> {
  if (!fetchableFreshworksImage(url)) {
    throw new KbImageFetchError('not a Freshworks address this job downloads from');
  }

  const timeoutMs = sizedTimeout(MAX_KB_IMAGE_BYTES);
  let content: Buffer;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new KbImageFetchError(
        `answered ${response.status}, a redirect${redirectHost(response, url)}, which this job does not follow`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new KbImageFetchError(`answered ${response.status}`);
    }
    content = await readBodyCapped(
      response,
      MAX_KB_IMAGE_BYTES,
      () => new KbImageFetchError(`is larger than ${MAX_KB_IMAGE_BYTES} bytes`),
    );
  } catch (error) {
    if (error instanceof KbImageFetchError) throw error;
    if (isTimeout(error)) {
      throw new KbImageFetchError(`did not answer in ${timeoutMs / 1000}s`);
    }
    throw new KbImageFetchError(error instanceof Error ? error.message : String(error));
  }

  const type = kbImageType(content);
  if (!type) throw new KbImageFetchError('is not a PNG, JPEG, GIF or WebP image');
  return { content, ...type };
}

/** ` to <host>` for a redirect's report line, when its Location says where. */
function redirectHost(response: Response, from: string): string {
  const location = response.headers.get('location');
  if (!location) return '';
  try {
    return ` to ${new URL(location, from).host}`;
  } catch {
    return '';
  }
}

/**
 * Stores a downloaded picture and records it as the copy of `sourceUrl`,
 * answering the id an article should name.
 *
 * The object first, then the row, so a row never names bytes that are not
 * there; the key is built from an id generated here. If another run recorded
 * the same address in between, its row wins — `source_url` is unique — and
 * the object this call wrote is removed, so the two runs agree on one id.
 *
 * An insert that throws for any other reason leaves the object where it is, on
 * purpose. Such a failure can be one the database committed anyway — the
 * admission gate in `db/client.ts` gives a statement up as lost while it may
 * still commit — and removing the object then would leave a row naming bytes
 * that are gone, which the next run would point the articles at. A stray
 * object in a private bucket costs a few hundred kilobytes; a broken picture on
 * the help centre is the failure this whole job exists to prevent.
 */
export async function storeKbImage(image: {
  content: Buffer;
  contentType: string;
  extension: string;
  sourceUrl: string;
}): Promise<{ id: string }> {
  const id = randomUUID();
  const stored = await uploadObject(
    `kb/${id}.${image.extension}`,
    image.content,
    image.contentType,
  );

  const [inserted] = await db
    .insert(kbImages)
    .values({
      id,
      storagePath: stored.path,
      contentType: image.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.checksum,
      sourceUrl: image.sourceUrl,
    })
    .onConflictDoNothing({ target: kbImages.sourceUrl })
    .returning({ id: kbImages.id });
  if (inserted) return inserted;

  const { failed } = await removeObjects([stored.path]);
  if (failed.length > 0) {
    log.warn(`another run copied ${image.sourceUrl} first; its duplicate is left at ${failed[0]}`);
  }
  const [existing] = await db
    .select({ id: kbImages.id })
    .from(kbImages)
    .where(eq(kbImages.sourceUrl, image.sourceUrl))
    .limit(1);
  if (!existing) throw new Error(`kb_images lost the row for ${image.sourceUrl}`);
  return existing;
}

/** The copy already made of each address, by the address it replaced. */
export async function kbImagesBySource(urls: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (urls.length === 0) return found;
  const rows = await db
    .select({ id: kbImages.id, sourceUrl: kbImages.sourceUrl })
    .from(kbImages)
    .where(inArray(kbImages.sourceUrl, [...urls]));
  for (const row of rows) if (row.sourceUrl) found.set(row.sourceUrl, row.id);
  return found;
}

/** The address each image replaced, by id, for the way back. */
export async function kbImageSources(ids: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (ids.length === 0) return found;
  const rows = await db
    .select({ id: kbImages.id, sourceUrl: kbImages.sourceUrl })
    .from(kbImages)
    .where(inArray(kbImages.id, [...ids]));
  for (const row of rows) if (row.sourceUrl) found.set(row.id, row.sourceUrl);
  return found;
}

/**
 * Points every Freshworks `src` already copied here at its copy, and leaves the
 * rest as they were.
 *
 * The console's Save and Restore run every body through this as they write it,
 * so a body that still carries Freshdesk's address — an editor tab opened
 * before `rehost_kb_images` ran and saved after it, a paste from an old copy of
 * the article — stores the copy instead of putting Freshdesk back. An address
 * with no copy yet is left alone: it is the job's to copy, and the next dry run
 * names it. Costs one query, and none for a body with no Freshworks picture.
 */
export async function withCopiedImages(html: string): Promise<string> {
  const sources = imageSources(html).filter(isFreshworksImage);
  if (sources.length === 0) return html;
  const copies = await kbImagesBySource(sources);
  if (copies.size === 0) return html;
  return rewriteImageSources(html, (src) => {
    const id = copies.get(src);
    return id ? kbImageSrc(id) : undefined;
  }).html;
}

/**
 * Where picture `id`'s bytes are, and whether a stranger may see it, or null
 * when no such picture is held.
 */
export async function kbImageFor(
  id: string,
): Promise<{ storagePath: string; shownPublicly: boolean } | null> {
  const [row] = await db
    .select({ storagePath: kbImages.storagePath })
    .from(kbImages)
    .where(eq(kbImages.id, id))
    .limit(1);
  if (!row) return null;
  return { storagePath: row.storagePath, shownPublicly: await shownTo(id, ANONYMOUS) };
}

/**
 * Whether an article this viewer may read shows picture `id`: published,
 * visible to them, in a folder visible to them, and naming the picture's
 * route in its body. The same two predicates every help-centre read applies.
 *
 * Versions are not asked: none is readable outside the console, and a Restore
 * that puts one back makes its pictures visible with it.
 */
export async function shownTo(id: string, viewer: KbViewer): Promise<boolean> {
  const rows = await db
    .select({ id: kbArticles.id })
    .from(kbArticles)
    .innerJoin(kbFolders, eq(kbFolders.id, kbArticles.folderId))
    .where(
      and(
        articleVisibleTo(viewer),
        folderVisibleTo(viewer),
        like(kbArticles.bodyHtml, containing(kbImageSrc(id))),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * How long a public picture's signed URL lives, and how much of that a reused
 * one must still have.
 *
 * Long, because the picture is public: the bucket is private for the
 * attachments beside it, not for these. A URL reused for half a day means an
 * article page asking for fifteen pictures costs no query and no Storage call
 * after the first reader, and the same URL for every reader is what lets
 * Storage's CDN and the browser cache the bytes. The other half of the day is
 * the margin for a browser or a cache that kept the redirect
 * (`KB_IMAGE_REDIRECT_MAX_AGE`) and follows it late. The cost is revocation: a
 * picture whose article stops being public stays reachable through a URL
 * already handed out until it expires, as any signed URL does.
 */
const PUBLIC_TTL_SECONDS = 24 * 60 * 60;
const REUSE_WHILE_LEFT_MS = 12 * 60 * 60 * 1000;

/** How long a browser or cache may keep a public picture's redirect. Well inside the margin above. */
export const KB_IMAGE_REDIRECT_MAX_AGE = 60 * 60;

/**
 * How long a restricted picture's signed URL lives, and how long its viewer's
 * browser may keep the redirect: an attachment's five minutes, and less than
 * that, so a kept redirect never points at an expired URL.
 */
const RESTRICTED_TTL_SECONDS = 5 * 60;
export const KB_IMAGE_RESTRICTED_MAX_AGE = 4 * 60;

/**
 * Public pictures' signed URLs already minted, per process. Bounded by the
 * number of pictures the knowledge base holds, which is in the hundreds;
 * cleared outright past `MEMO_LIMIT` rather than evicted with care, because a
 * miss costs two queries and one signature. A restricted picture is never
 * remembered: the reader is checked on every request.
 */
const memo = new Map<string, { url: string; expiresAt: number }>();
const MEMO_LIMIT = 5000;

/**
 * A signed URL for public picture `id` minted earlier in this process and
 * still good for long enough, or null. Costs nothing, so the route answers it
 * before its rate limit, which is there for what a miss costs.
 */
export function rememberedPublicKbImageUrl(id: string, now: number): string | null {
  const hit = memo.get(id);
  return hit && hit.expiresAt - now >= REUSE_WHILE_LEFT_MS ? hit.url : null;
}

/** A signed URL for a public picture, remembered for the readers after this one. */
export async function signPublicKbImageUrl(
  id: string,
  storagePath: string,
  now: number,
): Promise<string> {
  const url = await signedUrl(storagePath, PUBLIC_TTL_SECONDS);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(id, { url, expiresAt: now + PUBLIC_TTL_SECONDS * 1000 });
  return url;
}

/** A short-lived signed URL for a picture only some readers may see. Never remembered. */
export async function signRestrictedKbImageUrl(storagePath: string): Promise<string> {
  return signedUrl(storagePath, RESTRICTED_TTL_SECONDS);
}
