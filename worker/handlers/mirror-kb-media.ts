import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbMedia } from '@/db/schema';
import { sanitiseArticleHtml } from '@/lib/html/sanitize';
import {
  buildKbMediaPath,
  isMirrorableMediaUrl,
  isStorableMediaType,
  kbMediaPath,
  mirrorableSources,
  rewriteArticleMedia,
} from '@/lib/kb/media';
import type { ClaimedJob } from '@/lib/queue';
import { uploadObject } from '@/lib/storage';

/**
 * Copies the knowledge base's images off Freshdesk's CDN and onto ours.
 *
 * The import brought 112 articles across and left 214 pictures behind, still
 * loading from `s3.amazonaws.com/cdn.freshdesk.com`. They resolve today and
 * will keep resolving right up until the Freshdesk account is closed, at which
 * point 61 articles lose their screenshots and the two packaging articles — the
 * best-rated content on the site, which is nothing *but* screenshots — become
 * blank pages. There is no warning before that happens and no way back
 * afterwards, which is what makes this a job to run now rather than at cutover.
 *
 * Idempotent, and enqueued without a dedupe key for exactly that reason: this
 * has to be runnable again after the next import, after a partial failure, and
 * against articles added later. A key on the subject would make the second run
 * silently do nothing (see `EnqueueOptions.dedupeKey`).
 *
 * Runs article by article rather than image by image, and rewrites the HTML
 * only after every image in that article has been attempted. The ordering is
 * what makes a crash safe without a transaction around the whole thing: the
 * bytes and the `kb_media` row are written before any `src` points at them, so
 * an interrupted run leaves an article still naming Freshdesk — correct, just
 * not yet moved — rather than one pointing at objects that do not exist. An
 * image that fails keeps its original URL and the article stays in the
 * candidate set for the next run.
 */

/**
 * Bigger than any screenshot in the knowledge base — the largest today is under
 * 2 MB — and small enough that a redirect to something enormous cannot fill the
 * worker's memory.
 */
const MAX_BYTES = 10 * 1024 * 1024;

/** Per-article ceiling, so one pathological article cannot run for ever. */
const MAX_IMAGES_PER_ARTICLE = 60;

type Options = {
  /** Restrict to one article. Used when re-checking a single fix by hand. */
  articleId: string | null;
  /** Articles per run. The default clears the whole backlog in one go. */
  limit: number;
  /** Report what would be copied without fetching or writing anything. */
  dryRun: boolean;
};

function options(job: ClaimedJob): Options {
  const payload = job.payload as Record<string, unknown>;
  const limit = Number(payload.limit);

  return {
    articleId: typeof payload.articleId === 'string' ? payload.articleId : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 200,
    // `npm run job` hands every trailing pair over as a string, so the literal
    // "false" has to be false here — otherwise `dryRun=false` is truthy and the
    // rehearsal flag silently becomes impossible to turn off.
    dryRun: payload.dryRun === true || payload.dryRun === 'true',
  };
}

export async function mirrorKbMedia(job: ClaimedJob): Promise<void> {
  const { articleId, limit, dryRun } = options(job);

  // `body_html LIKE` rather than a join through `kb_media`: an article is
  // finished when its HTML no longer names a mirrorable host, which is the
  // condition that actually matters and is true even for the articles that
  // never had any images. Rows in `kb_media` say what was copied, not what is
  // left to do.
  const candidates = await db
    .select({ id: kbArticles.id, title: kbArticles.title, bodyHtml: kbArticles.bodyHtml })
    .from(kbArticles)
    .where(
      and(
        sql`${kbArticles.bodyHtml} like '%cdn.freshdesk.com%'`,
        articleId ? eq(kbArticles.id, articleId) : undefined,
      ),
    )
    .orderBy(kbArticles.id)
    .limit(limit);

  if (candidates.length === 0) {
    console.log('[mirror_kb_media] nothing left to copy');
    return;
  }

  let copied = 0;
  let reused = 0;
  let failed = 0;
  let rewritten = 0;

  for (const article of candidates) {
    const sources = mirrorableSources(article.bodyHtml).slice(0, MAX_IMAGES_PER_ARTICLE);
    if (sources.length === 0) continue;

    // Anything copied on an earlier run: its bytes are already ours and the
    // only thing left is the rewrite. This is what makes a second run cheap
    // rather than a second download of everything.
    const existing = await db
      .select({ id: kbMedia.id, sourceUrl: kbMedia.sourceUrl })
      .from(kbMedia)
      .where(eq(kbMedia.articleId, article.id));

    const stored = new Map(existing.map((row) => [row.sourceUrl, kbMediaPath(row.id)]));
    reused += existing.length;

    if (dryRun) {
      const outstanding = sources.filter((source) => !stored.has(source));
      console.log(
        `[mirror_kb_media] would copy ${outstanding.length} of ${sources.length} for "${article.title}"`,
      );
      continue;
    }

    for (const source of sources) {
      if (stored.has(source)) continue;

      try {
        const media = await fetchImage(source);
        const path = buildKbMediaPath(source, media.contentType);
        const object = await uploadObject(path, media.content, media.contentType);

        // `onConflictDoUpdate` rather than `DoNothing`: a run that uploaded the
        // object and then died before the rewrite must be able to finish, and
        // `returning` on a `DoNothing` that conflicts hands back no row at all.
        const [row] = await db
          .insert(kbMedia)
          .values({
            articleId: article.id,
            sourceUrl: source,
            storagePath: object.path,
            contentType: media.contentType,
            sizeBytes: object.sizeBytes,
            checksum: object.checksum,
          })
          .onConflictDoUpdate({
            target: [kbMedia.articleId, kbMedia.sourceUrl],
            set: {
              storagePath: object.path,
              contentType: media.contentType,
              sizeBytes: object.sizeBytes,
              checksum: object.checksum,
            },
          })
          .returning({ id: kbMedia.id });

        stored.set(source, kbMediaPath(row!.id));
        copied += 1;
      } catch (error) {
        // One dead image must not cost the other 213. The article keeps its
        // original URL for this one, stays in the candidate set, and the next
        // run tries again — which is the right behaviour for a CDN hiccup and
        // harmless for a genuinely missing file.
        failed += 1;
        console.error(
          `[mirror_kb_media] ${source} failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    const bodyHtml = sanitiseArticleHtml(rewriteArticleMedia(article.bodyHtml, stored));
    if (bodyHtml === article.bodyHtml) continue;

    // `updated_at` is deliberately not touched. It is what the help centre
    // prints as "Updated <date>" on every article, and moving 61 of them to
    // today would tell every reader the content was revised when only the
    // image host changed. `body_text` is not touched either: images contribute
    // nothing to it, so the search vector is unaffected.
    await db.update(kbArticles).set({ bodyHtml }).where(eq(kbArticles.id, article.id));
    rewritten += 1;
  }

  console.log(
    `[mirror_kb_media] ${candidates.length} articles examined · ${copied} copied · ${reused} already stored · ${failed} failed · ${rewritten} rewritten`,
  );
}

/**
 * Fetch one image, refusing anything that is not one.
 *
 * `redirect: 'error'` is the load-bearing option. The allowlist in
 * `lib/kb/media.ts` checks the URL we are about to request, and a 302 would let
 * the far end choose the next one — which is the whole allowlist undone by the
 * server it was protecting us from. Freshdesk's CDN serves these directly, so
 * there is nothing legitimate to follow.
 */
async function fetchImage(url: string): Promise<{ content: Buffer; contentType: string }> {
  if (!isMirrorableMediaUrl(url)) throw new Error('refusing to fetch a URL off the allowlist');

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`download failed with ${response.status}`);

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (!isStorableMediaType(contentType)) {
    await response.body?.cancel();
    throw new Error(`refusing content type "${contentType || 'none'}"`);
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`declared ${declared} bytes, over the ${MAX_BYTES} limit`);
  }

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length > MAX_BYTES) throw new Error(`${content.length} bytes, over the limit`);
  if (content.length === 0) throw new Error('empty body');

  return { content, contentType };
}
