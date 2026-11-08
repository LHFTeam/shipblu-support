import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbImages } from '@/db/schema';
import { isTimeout, sizedTimeout } from '@/lib/http/deadline';
import { removeObjects, signedUrl, uploadObject } from '@/lib/storage';
import { sniffWidgetFile } from '@/lib/widget/sniff';
import { fetchableFreshworksImage } from './image-src';

/**
 * The knowledge base's own pictures: copied in, stored, and handed out.
 *
 * An article names a picture by `/api/kb/images/<id>` (`./image-src.ts`), the
 * row says where its bytes are, and the route redirects to a signed URL for
 * them. The bucket is the attachments bucket, private, because it also holds
 * customers' invoices and ID documents; these pictures are public, so the
 * signature here is long and reused (`kbImageRedirect`), where an
 * attachment's is five minutes and minted per view.
 */

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
 * for anything, and refuses a redirect that lands anywhere it would not
 * accept either, so the job reaches Freshworks and nothing else. Every failure
 * is a `KbImageFetchError` naming what went wrong; the job keeps the old
 * address and reports it.
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
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // `redirected`, not a comparison of the two strings: `fetch` hands back the
    // URL it parsed, which can differ from ours in spelling alone.
    if (response.redirected && !fetchableFreshworksImage(response.url)) {
      await response.body?.cancel();
      throw new KbImageFetchError(
        `redirected away from Freshworks, to ${new URL(response.url).host}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new KbImageFetchError(`answered ${response.status}`);
    }
    content = await readCapped(response, MAX_KB_IMAGE_BYTES);
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

/**
 * The body, refusing it as soon as it passes `maxBytes` — a declared length
 * up front, and the stream mid-read where there is none — for the reason
 * `downloadAttachment` in `lib/meta/client.ts` gives.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new KbImageFetchError(`is larger than ${maxBytes} bytes`);

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > maxBytes) throw tooLarge();
    return content;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Stores a downloaded picture and records it as the copy of `sourceUrl`,
 * answering the id an article should name.
 *
 * The object first, then the row, so a row never names bytes that are not
 * there; the key is built from an id generated here. If another run recorded
 * the same address in between, its row wins — `source_url` is unique — and
 * the object this call wrote is removed, so the two runs agree on one id.
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

  await removeObjects([stored.path]);
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
 * How long a signed URL for a picture lives, and how much of that a reused one
 * must still have.
 *
 * Long, because the picture is public: the bucket is private for the
 * attachments beside it, not for these. A URL reused for half a day means an
 * article page asking for fifteen pictures costs no query and no Storage call
 * after the first reader, and the same URL for every reader is what lets
 * Storage's CDN and the browser cache the bytes. The other half of the day is
 * the margin for a browser or a cache that kept the redirect
 * (`KB_IMAGE_REDIRECT_MAX_AGE`) and follows it late.
 */
const SIGNED_TTL_SECONDS = 24 * 60 * 60;
const REUSE_WHILE_LEFT_MS = 12 * 60 * 60 * 1000;

/** How long a browser or cache may keep the redirect itself. Well inside the margin above. */
export const KB_IMAGE_REDIRECT_MAX_AGE = 60 * 60;

/**
 * Signed URLs already minted, per process. Bounded by the number of pictures
 * the knowledge base holds, which is in the hundreds; cleared outright past
 * `MEMO_LIMIT` rather than evicted with care, because a miss costs one query
 * and one signature.
 */
const memo = new Map<string, { url: string; expiresAt: number }>();
const MEMO_LIMIT = 5000;

/**
 * A signed URL for picture `id` minted earlier in this process and still good
 * for long enough, or null. Costs nothing, so the route answers it before its
 * rate limit, which is there for what a miss costs.
 */
export function rememberedKbImageUrl(id: string, now: number): string | null {
  const hit = memo.get(id);
  return hit && hit.expiresAt - now >= REUSE_WHILE_LEFT_MS ? hit.url : null;
}

/** A fresh signed URL for picture `id`, or null when no such picture is held. */
export async function signKbImageUrl(id: string, now: number): Promise<string | null> {
  const [row] = await db
    .select({ storagePath: kbImages.storagePath })
    .from(kbImages)
    .where(eq(kbImages.id, id))
    .limit(1);
  if (!row) return null;

  const url = await signedUrl(row.storagePath, SIGNED_TTL_SECONDS);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(id, { url, expiresAt: now + SIGNED_TTL_SECONDS * 1000 });
  return url;
}
