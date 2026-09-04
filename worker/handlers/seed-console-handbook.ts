import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from '@/lib/kb/format';
import { HANDBOOK, HANDBOOK_CATEGORY, HANDBOOK_LOCALE } from '@/lib/kb/handbook';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Puts the team's own handbook into the knowledge base.
 *
 * A job rather than a migration for the reason `normalise_kb_formatting` gives:
 * it needs `sanitiseArticleHtml` and `normaliseArticleHtml`, and a hand-written
 * SQL twin of 200 lines of markup rules would be a second implementation to
 * keep in step with the first. The content itself is `lib/kb/handbook.ts`; this
 * file is only the upsert.
 *
 * **What it owns, and what it leaves alone.** These articles are meant to be
 * edited in the console after seeding — that is the whole reason they are
 * knowledge-base rows rather than files in this repository — so a re-run that
 * silently reverted somebody's improvement would be worse than a stale seed.
 * The split:
 *
 *  - The **category and the folders** are synced every run, including each
 *    folder's `visibility` and its `min_role`. That pair is the audience
 *    guarantee the whole feature rests on, and it is the one thing that must
 *    not be recoverable by accident: a folder that lost its floor publishes
 *    four supervisor articles to every agent, and nobody would notice.
 *  - An **article's folder, visibility and position** are synced too, for the
 *    same reason — an article that drifted out of its folder has left the floor
 *    behind.
 *  - An **article's title and body** are written on insert, and afterwards only
 *    with `overwrite=true`, which is how a content fix from this repository is
 *    shipped. Either way a `kb_article_versions` row is cut for what is being
 *    replaced, so the pass is undoable article by article from the console.
 *  - An **article's `status` and its own `min_role`** are never touched after
 *    insert. Re-publishing what somebody archived, or widening a floor
 *    somebody tightened on one article, are both writes this job has no
 *    business making. The folder's floor still applies underneath: the
 *    stricter of the two wins (`lib/kb/internal.ts`).
 *
 * Idempotent, and enqueued **without a `dedupeKey`** for the reason spelled out
 * in `AGENTS.md`: a key is spent for good rather than until the job finishes,
 * so keying this would make the second run silently do nothing — the opposite
 * of what a re-runnable seed wants.
 */

type Payload = {
  /** Report what would change, write nothing. */
  dryRun?: boolean;
  /** Also replace the title and body of articles that already exist. */
  overwrite?: boolean;
};

type Tally = {
  foldersCreated: number;
  foldersUpdated: number;
  articlesCreated: number;
  articlesRewritten: number;
  /** Differ from what this repository says, and were left as they are. */
  articlesDrifted: number;
  articlesUnchanged: number;
};

/**
 * Identity that survives a retitle and a reslug.
 *
 * `(source_system, external_id)` is unique on all three tables, so this is the
 * conflict target as well as the lookup — and `source_system` stays `native`
 * because these articles were written here, not imported from anywhere.
 */
const externalId = {
  category: 'handbook:category',
  folder: (key: string) => `handbook:folder:${key}`,
  article: (key: string) => `handbook:${key}`,
};

export async function seedConsoleHandbook(job: ClaimedJob): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const dryRun = payload.dryRun === true;
  const overwrite = payload.overwrite === true;

  const tally: Tally = {
    foldersCreated: 0,
    foldersUpdated: 0,
    articlesCreated: 0,
    articlesRewritten: 0,
    articlesDrifted: 0,
    articlesUnchanged: 0,
  };

  const categoryId = await upsertCategory(dryRun);
  if (categoryId === null) {
    report(tally, dryRun, 'would create the category; nothing below it can be resolved yet');
    return;
  }

  for (const [index, folder] of HANDBOOK.entries()) {
    const folderId = await upsertFolder(categoryId, folder, index, dryRun, tally);
    if (folderId === null) continue;

    for (const [position, article] of folder.articles.entries()) {
      await upsertArticle(folderId, article, position, { dryRun, overwrite }, tally);
    }
  }

  report(tally, dryRun);
}

async function upsertCategory(dryRun: boolean): Promise<string | null> {
  const existing = await db
    .select({ id: kbCategories.id })
    .from(kbCategories)
    .where(
      and(
        eq(kbCategories.sourceSystem, 'native'),
        eq(kbCategories.externalId, externalId.category),
      ),
    )
    .limit(1);

  if (existing[0]) {
    if (!dryRun) {
      await db
        .update(kbCategories)
        .set({ name: HANDBOOK_CATEGORY.name, description: HANDBOOK_CATEGORY.description })
        .where(eq(kbCategories.id, existing[0].id));
    }
    return existing[0].id;
  }

  if (dryRun) return null;

  const inserted = await db
    .insert(kbCategories)
    .values({
      name: HANDBOOK_CATEGORY.name,
      slug: HANDBOOK_CATEGORY.slug,
      description: HANDBOOK_CATEGORY.description,
      locale: HANDBOOK_LOCALE,
      // Last in the tree. The two customer-facing categories are what somebody
      // opening the knowledge base is usually looking for.
      position: 100,
      externalId: externalId.category,
    })
    .returning({ id: kbCategories.id });

  return inserted[0]!.id;
}

async function upsertFolder(
  categoryId: string,
  folder: (typeof HANDBOOK)[number],
  position: number,
  dryRun: boolean,
  tally: Tally,
): Promise<string | null> {
  const shape = {
    categoryId,
    name: folder.name,
    description: folder.description,
    // Both, every run. This is the line the feature is built on.
    visibility: 'agents_only' as const,
    minRole: folder.minRole,
    position,
  };

  const existing = await db
    .select({ id: kbFolders.id })
    .from(kbFolders)
    .where(
      and(
        eq(kbFolders.sourceSystem, 'native'),
        eq(kbFolders.externalId, externalId.folder(folder.key)),
      ),
    )
    .limit(1);

  if (existing[0]) {
    tally.foldersUpdated += 1;
    if (!dryRun) {
      await db.update(kbFolders).set(shape).where(eq(kbFolders.id, existing[0].id));
    }
    return existing[0].id;
  }

  tally.foldersCreated += 1;
  if (dryRun) return null;

  const inserted = await db
    .insert(kbFolders)
    .values({ ...shape, slug: folder.slug, externalId: externalId.folder(folder.key) })
    .returning({ id: kbFolders.id });

  return inserted[0]!.id;
}

async function upsertArticle(
  folderId: string,
  article: (typeof HANDBOOK)[number]['articles'][number],
  position: number,
  options: { dryRun: boolean; overwrite: boolean },
  tally: Tally,
): Promise<void> {
  // The same pair, in the same order, as every other write path: sanitising is
  // the security boundary and normalising is the formatting pass that relies on
  // being handed the sanitiser's canonical output. `handbook.test.ts` asserts
  // each body is already a fixed point of this, so on a healthy run these two
  // calls change nothing — which is what makes the comparison below meaningful.
  const bodyHtml = normaliseArticleHtml(sanitiseArticleHtml(article.bodyHtml));
  const bodyText = htmlToText(bodyHtml);

  const existing = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      bodyHtml: kbArticles.bodyHtml,
    })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.sourceSystem, 'native'),
        eq(kbArticles.externalId, externalId.article(article.key)),
      ),
    )
    .limit(1);

  const row = existing[0];

  if (!row) {
    tally.articlesCreated += 1;
    if (options.dryRun) return;

    await db.insert(kbArticles).values({
      folderId,
      title: article.title,
      slug: article.slug,
      bodyHtml,
      bodyText,
      excerpt: preview(bodyText, 200),
      locale: HANDBOOK_LOCALE,
      // Published, because a draft is invisible to the one surface an agent
      // reaches this content from while working: the composer's knowledge
      // panel filters on `status = 'published'`.
      status: 'published',
      publishedAt: new Date(),
      // Marked internal on the row as well as on the folder. The folder alone
      // would be enough for every query this codebase has today; the belt and
      // braces are because production's imported internal articles are marked
      // `public` and rely on the folder entirely, and one read model that
      // forgot the join would publish them — the unnumbered §6 trap "A
      // `published`/`public` article can sit inside a folder nobody may read".
      visibility: 'agents_only',
      // Null: the folder carries the floor, so an article added to the folder
      // later inherits the right audience instead of needing to be remembered.
      minRole: null,
      position,
      externalId: externalId.article(article.key),
    });
    return;
  }

  const changed = row.title !== article.title || row.bodyHtml !== bodyHtml;
  const rewriting = changed && options.overwrite;

  if (rewriting) tally.articlesRewritten += 1;
  else if (changed) tally.articlesDrifted += 1;
  else tally.articlesUnchanged += 1;

  if (options.dryRun) return;

  await db.transaction(async (tx) => {
    if (rewriting) {
      // The state being replaced, kept where the console's own version history
      // keeps it, so a content push from this repository is undoable from the
      // UI rather than only from a database backup. `edited_by_agent_id` stays
      // null: no agent made this edit.
      const next = await tx
        .select({ version: sql<number>`coalesce(max(${kbArticleVersions.version}), 0) + 1` })
        .from(kbArticleVersions)
        .where(eq(kbArticleVersions.articleId, row.id));

      await tx.insert(kbArticleVersions).values({
        articleId: row.id,
        version: next[0]?.version ?? 1,
        title: row.title,
        bodyHtml: row.bodyHtml,
      });
    }

    await tx
      .update(kbArticles)
      .set({
        // Always: an article that drifted out of its folder has left the floor
        // behind, and one whose visibility was widened is on the help centre.
        folderId,
        visibility: 'agents_only',
        position,
        ...(rewriting
          ? { title: article.title, bodyHtml, bodyText, excerpt: preview(bodyText, 200) }
          : {}),
      })
      .where(eq(kbArticles.id, row.id));
  });
}

function report(tally: Tally, dryRun: boolean, note?: string): void {
  const tag = '[seed_console_handbook]';

  if (note) console.log(`${tag} ${note}`);

  console.log(
    `${tag} folders ${tally.foldersCreated} created, ${tally.foldersUpdated} updated ` +
      `(dry_run=${dryRun})`,
  );
  console.log(
    `${tag} articles ${tally.articlesCreated} created, ${tally.articlesRewritten} rewritten, ` +
      `${tally.articlesUnchanged} already current`,
  );

  // Named rather than folded into "left alone", because the two mean opposite
  // things. An article that matches this repository needs nothing; one that
  // differs is either somebody's improvement — which is what the console is
  // for — or a content fix in this repository that has not been pushed yet,
  // and only a person can tell those apart.
  if (tally.articlesDrifted > 0) {
    console.log(
      `${tag} ${tally.articlesDrifted} article(s) differ from this repository and were left ` +
        `as they are; re-run with overwrite=true to replace them`,
    );
  }

  // Per audience rather than as one number, for the reason §7 of the working
  // brief gives about per-locale reporting: "16 articles seeded" reads as a
  // clean run even if the supervisor folder ended up empty, and an audience
  // with nothing addressed to it is exactly the failure worth seeing.
  console.log(`${tag} ${'audience'.padEnd(16)}${'folder'.padStart(26)}${'articles'.padStart(10)}`);
  for (const folder of HANDBOOK) {
    console.log(
      `${tag} ${folder.minRole.padEnd(16)}${folder.slug.padStart(26)}` +
        `${String(folder.articles.length).padStart(10)}`,
    );
  }
}
