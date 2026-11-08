import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles } from '@/db/schema';
import {
  fetchableFreshworksImage,
  imageSources,
  isFreshworksImage,
  kbImageIdOf,
  kbImageSrc,
  rewriteImageSources,
} from '@/lib/kb/image-src';
import {
  downloadFreshworksImage,
  kbImageSources,
  kbImagesBySource,
  KbImageFetchError,
  storeKbImage,
} from '@/lib/kb/images';
import { logger } from '@/lib/log';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';

/**
 * Copies every picture the knowledge base hot-links from Freshdesk into our own
 * bucket, and points the articles at the copies.
 *
 * The one change that makes "the knowledge base does not depend on Freshdesk"
 * true, and the one that cannot be made once the account is closed: on
 * 2026-11-07 all 214 images in 61 of the 112 articles, and the same 214 in
 * their versions, loaded from Freshdesk's attachment bucket
 * (`plans/freshdesk-disconnection.md`, PR 1). Run it `dryRun=true`, then for
 * real, then `dryRun=true` again, which should report nothing to do.
 *
 * **Versions are rewritten in place, and no version is cut.** The plan asked
 * for a version per article first, as `normalise_kb_formatting` cuts, and this
 * departs from it for three reasons, each enough on its own:
 *
 * - A version holding the Freshdesk address is exactly the latent hazard the
 *   plan lists first: one Restore by anybody with `kb.edit` puts it back on the
 *   public page. Cutting one per article would create 61 of them.
 * - The plan's own check is that the audit's `images, versions` row answers 0,
 *   which a version holding the old address makes impossible.
 * - The help centre dates an article by its newest version (`editedAt` in
 *   `lib/kb/queries.ts`), so 61 articles would read "updated today" for a change
 *   no reader can see: the picture is the same, only its address moves.
 *
 * The way back is the job itself: `kb_images.source_url` holds the address each
 * copy replaced, and `revert=true` writes it back into every article and
 * version that names the copy. That works until Freshdesk stops serving the
 * originals, and after that there is no way back by design, which is why this
 * runs before the account closes and not after.
 *
 * Safe to run again, and enqueued **without a `dedupeKey`** for the reason
 * `normalise_kb_formatting` gives: a copy is found by its source address, so a
 * second run downloads nothing it already has, and an article already pointing
 * at its copies is not written. A picture that fails to download keeps its old
 * address and is reported by name; no `<img>` is ever dropped.
 *
 * Each write compares before it sets (`body_html` still what was read), so an
 * editor saving an article while the job runs keeps their edit, and the job
 * reports the article for the next run instead.
 *
 * Only `body_html` is written. `body_text` and `excerpt` are derived with
 * images skipped (`htmlToText`), so an address moving changes neither, and the
 * row's `updated_at` moves by the trigger, as it does for any UPDATE — the
 * console's list floats these articles to the top, which is honest: the rows
 * changed. The public date does not move, since no version is cut.
 */

type Body = {
  kind: 'article' | 'version';
  id: string;
  locale: string;
  /** `ar/<slug>`, or `ar/<slug>@v2` for a version, for the report. */
  label: string;
  bodyHtml: string;
};

type Tally = {
  articles: number;
  versions: number;
  /** Freshworks addresses found, counting each `<img>`. */
  inArticles: number;
  inVersions: number;
  rewroteArticles: number;
  rewroteVersions: number;
};

function emptyTally(): Tally {
  return {
    articles: 0,
    versions: 0,
    inArticles: 0,
    inVersions: 0,
    rewroteArticles: 0,
    rewroteVersions: 0,
  };
}

type Plan = {
  /** The bodies whose HTML changes, with what they change to. */
  rewrites: { body: Body; next: string; replaced: number }[];
  copied: number;
  reused: number;
  /** Addresses a real run would download; counted only on a dry run. */
  wouldCopy: number;
  failed: { url: string; reason: string; in: string[] }[];
  /** Images left alone on the way back because nothing records where they came from. */
  noSource: number;
};

export async function rehostKbImages(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'rehost_kb_images');
  const dryRun = payload.dryRun === true;
  const revert = payload.revert === true;

  const bodies = await loadBodies(payload.locale, payload.limit);
  const plan = revert ? await planRevert(bodies) : await planForward(bodies, dryRun);
  const raced = dryRun ? [] : await write(plan.rewrites);

  report(bodies, plan, raced, { dryRun, revert });
}

/**
 * The articles in scope, ordered as `normalise_kb_formatting` orders them, and
 * every version of each.
 *
 * Versions are in scope because a Restore re-publishes one: a picture an
 * article has since dropped is still copied if a version shows it, or that
 * Restore would bring Freshdesk's address back.
 */
async function loadBodies(locale: string | undefined, limit: number | undefined): Promise<Body[]> {
  const articleRows = await db
    .select({
      id: kbArticles.id,
      locale: kbArticles.locale,
      slug: kbArticles.slug,
      bodyHtml: kbArticles.bodyHtml,
    })
    .from(kbArticles)
    .where(locale ? eq(kbArticles.locale, locale) : undefined)
    .orderBy(asc(kbArticles.locale), asc(kbArticles.slug));
  const articles = limit ? articleRows.slice(0, limit) : articleRows;
  if (articles.length === 0) return [];

  const versionRows = await db
    .select({
      id: kbArticleVersions.id,
      articleId: kbArticleVersions.articleId,
      version: kbArticleVersions.version,
      bodyHtml: kbArticleVersions.bodyHtml,
    })
    .from(kbArticleVersions)
    .where(
      inArray(
        kbArticleVersions.articleId,
        articles.map((article) => article.id),
      ),
    )
    .orderBy(asc(kbArticleVersions.articleId), asc(kbArticleVersions.version));

  const byId = new Map(articles.map((article) => [article.id, article]));
  const bodies: Body[] = articles.map((article) => ({
    kind: 'article',
    id: article.id,
    locale: article.locale,
    label: `${article.locale}/${article.slug}`,
    bodyHtml: article.bodyHtml,
  }));
  for (const version of versionRows) {
    const article = byId.get(version.articleId);
    if (!article) continue;
    bodies.push({
      kind: 'version',
      id: version.id,
      locale: article.locale,
      label: `${article.locale}/${article.slug}@v${version.version}`,
      bodyHtml: version.bodyHtml,
    });
  }
  return bodies;
}

/** Copy what has no copy yet, then point every body at the copies. */
async function planForward(bodies: Body[], dryRun: boolean): Promise<Plan> {
  const where = new Map<string, string[]>();
  for (const body of bodies) {
    for (const src of imageSources(body.bodyHtml)) {
      if (!isFreshworksImage(src)) continue;
      const labels = where.get(src) ?? [];
      if (!labels.includes(body.label)) labels.push(body.label);
      where.set(src, labels);
    }
  }

  const copies = await kbImagesBySource([...where.keys()]);
  const plan: Plan = {
    rewrites: [],
    copied: 0,
    reused: copies.size,
    wouldCopy: 0,
    failed: [],
    noSource: 0,
  };
  // A dry run rewrites with this stand-in so it can count the bodies a real
  // run would change; nothing it builds is written.
  const wouldBe = new Set<string>();

  for (const [url, labels] of where) {
    if (copies.has(url)) continue;

    if (!fetchableFreshworksImage(url)) {
      plan.failed.push({
        url,
        reason: 'not a Freshworks address this job downloads from',
        in: labels,
      });
      continue;
    }
    if (dryRun) {
      plan.wouldCopy += 1;
      wouldBe.add(url);
      continue;
    }

    try {
      const image = await downloadFreshworksImage(url);
      const { id } = await storeKbImage({ ...image, sourceUrl: url });
      copies.set(url, id);
      plan.copied += 1;
    } catch (error) {
      // A download that failed is named and kept, as is our own storage
      // failing: either way the article keeps the address it has, and the
      // next run tries again.
      const reason =
        error instanceof KbImageFetchError
          ? error.message
          : `could not be stored: ${error instanceof Error ? error.message : String(error)}`;
      plan.failed.push({ url, reason, in: labels });
    }
  }

  for (const body of bodies) {
    const { html: next, replaced } = rewriteImageSources(body.bodyHtml, (src) => {
      const id = copies.get(src);
      if (id) return kbImageSrc(id);
      return wouldBe.has(src) ? kbImageSrc(DRY_RUN_ID) : undefined;
    });
    if (replaced > 0) plan.rewrites.push({ body, next, replaced });
  }
  return plan;
}

const DRY_RUN_ID = '00000000-0000-0000-0000-000000000000';

/** Put back the address each copy replaced, wherever a body names the copy. */
async function planRevert(bodies: Body[]): Promise<Plan> {
  const ids = new Set<string>();
  for (const body of bodies) {
    for (const src of imageSources(body.bodyHtml)) {
      const id = kbImageIdOf(src);
      if (id) ids.add(id);
    }
  }

  const sources = await kbImageSources([...ids]);
  const plan: Plan = {
    rewrites: [],
    copied: 0,
    reused: 0,
    wouldCopy: 0,
    failed: [],
    noSource: 0,
  };

  for (const body of bodies) {
    const { html: next, replaced } = rewriteImageSources(body.bodyHtml, (src) => {
      const id = kbImageIdOf(src);
      if (!id) return undefined;
      const source = sources.get(id);
      if (!source) plan.noSource += 1;
      return source;
    });
    if (replaced > 0) plan.rewrites.push({ body, next, replaced });
  }
  return plan;
}

/**
 * Writes each body only if it is still the one that was read, and answers the
 * labels of those that were not.
 */
async function write(rewrites: Plan['rewrites']): Promise<string[]> {
  const raced: string[] = [];
  for (const { body, next } of rewrites) {
    const rows =
      body.kind === 'article'
        ? await db
            .update(kbArticles)
            .set({ bodyHtml: next })
            .where(and(eq(kbArticles.id, body.id), eq(kbArticles.bodyHtml, body.bodyHtml)))
            .returning({ id: kbArticles.id })
        : await db
            .update(kbArticleVersions)
            .set({ bodyHtml: next })
            .where(
              and(eq(kbArticleVersions.id, body.id), eq(kbArticleVersions.bodyHtml, body.bodyHtml)),
            )
            .returning({ id: kbArticleVersions.id });
    if (rows.length === 0) raced.push(body.label);
  }
  return raced;
}

function report(
  bodies: Body[],
  plan: Plan,
  raced: string[],
  mode: { dryRun: boolean; revert: boolean },
): void {
  const log = logger('rehost_kb_images');
  const tallies = new Map<string, Tally>();
  const tallyOf = (locale: string) => {
    const tally = tallies.get(locale) ?? emptyTally();
    tallies.set(locale, tally);
    return tally;
  };

  for (const body of bodies) {
    const tally = tallyOf(body.locale);
    const found = imageSources(body.bodyHtml).filter((src) =>
      mode.revert ? kbImageIdOf(src) !== null : isFreshworksImage(src),
    ).length;
    if (body.kind === 'article') {
      tally.articles += 1;
      tally.inArticles += found;
    } else {
      tally.versions += 1;
      tally.inVersions += found;
    }
  }
  const missed = new Set(raced);
  for (const { body } of plan.rewrites) {
    if (missed.has(body.label)) continue;
    const tally = tallyOf(body.locale);
    if (body.kind === 'article') tally.rewroteArticles += 1;
    else tally.rewroteVersions += 1;
  }

  const articles = bodies.filter((body) => body.kind === 'article').length;
  log.info(`${articles} articles, ${bodies.length - articles} versions`, {
    dry_run: mode.dryRun,
    revert: mode.revert,
  });

  // Per locale, for the reason `normalise_kb_formatting` reports that way: one
  // total reads as a clean run even if every Arabic article was skipped. The
  // image columns count each `<img>` still on Freshworks — or, on the way back,
  // still on our route — before this run.
  const found = mode.revert ? 'ours' : 'fresh';
  log.info(
    `${'locale'.padEnd(8)}${'articles'.padStart(9)}${found.padStart(7)}` +
      `${'versions'.padStart(9)}${found.padStart(7)}` +
      `${(mode.dryRun ? 'would' : 'wrote').padStart(7)}${'v.'.padStart(5)}`,
  );
  for (const [locale, tally] of [...tallies.entries()].sort()) {
    log.info(
      `${locale.padEnd(8)}${String(tally.articles).padStart(9)}` +
        `${String(tally.inArticles).padStart(7)}${String(tally.versions).padStart(9)}` +
        `${String(tally.inVersions).padStart(7)}${String(tally.rewroteArticles).padStart(7)}` +
        `${String(tally.rewroteVersions).padStart(5)}`,
    );
  }

  if (mode.revert) {
    log.info('revert', { left_without_source: plan.noSource });
  } else {
    log.info('images', {
      copied: plan.copied,
      already_copied: plan.reused,
      would_copy: mode.dryRun ? plan.wouldCopy : undefined,
      failed: plan.failed.length,
    });
  }

  for (const failure of plan.failed) {
    log.info(`kept ${failure.url}: ${failure.reason}`, { in: failure.in.join(',') });
  }
  for (const label of raced) {
    log.info(`skipped ${label}: it changed while the job ran, run it again`);
  }

  const nothing = plan.rewrites.length === 0 && plan.failed.length === 0 && plan.wouldCopy === 0;
  if (nothing) log.info('nothing to do');
}
