import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { articleBody, cutArticleVersion } from '@/lib/kb/article-write';
import { HANDBOOK, HANDBOOK_CATEGORY, HANDBOOK_LOCALE } from '@/lib/kb/handbook';
import type { AgentRole } from '@/lib/auth/permissions';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

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
 * **A run with nothing to do issues no UPDATE at all**, which is a stronger
 * claim than it sounds and has to be maintained deliberately. Every table with
 * an `updated_at` carries `touch_updated_at BEFORE UPDATE` from
 * `db/sql/001_extensions_and_triggers.sql`, so an unconditional
 * `set({folderId, visibility, position})` on a row that already holds those
 * values still moves the timestamp — 20 rows a run, reported as "already
 * current". `/kb` orders by `updated_at desc`, so the whole handbook would jump
 * to the top of the list every time somebody re-ran the seed, which is the
 * misleading-`updated_at` trap §6.51 already records once.
 *
 * Idempotent, and enqueued **without a `dedupeKey`** for the reason spelled out
 * in `AGENTS.md`: a key is spent for good rather than until the job finishes,
 * so keying this would make the second run silently do nothing — the opposite
 * of what a re-runnable seed wants.
 */

type Tally = {
  foldersCreated: number;
  foldersUpdated: number;
  articlesCreated: number;
  articlesRewritten: number;
  /** Differ from what this repository says, and were left as they are. */
  articlesDrifted: number;
  articlesUnchanged: number;
  /**
   * Articles reached, per folder, counted as the run reaches them.
   *
   * Deliberately not read back off `HANDBOOK` when reporting: printing the
   * constant that produced the work makes the table an echo, and it would show
   * a healthy three beside the supervisor folder on a run where those three
   * were never touched.
   */
  perFolder: Map<string, { minRole: AgentRole; reached: number }>;
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
  const payload = parseJobPayload(job, 'seed_console_handbook');
  const dryRun = payload.dryRun === true;
  const overwrite = payload.overwrite === true;

  const tally: Tally = {
    foldersCreated: 0,
    foldersUpdated: 0,
    articlesCreated: 0,
    articlesRewritten: 0,
    articlesDrifted: 0,
    articlesUnchanged: 0,
    perFolder: new Map(),
  };

  // Null only in a dry run against a database that has never been seeded. The
  // walk continues on it rather than returning: a dry run is read on the way to
  // the first real seed, and "the category does not exist yet" is not an answer
  // to "what is this about to write".
  const categoryId = await upsertCategory(dryRun);

  for (const [index, folder] of HANDBOOK.entries()) {
    const folderId = await upsertFolder(categoryId, folder, index, dryRun, tally);
    tally.perFolder.set(folder.slug, { minRole: folder.minRole, reached: 0 });

    for (const [position, article] of folder.articles.entries()) {
      // A dry run reaches the articles even when the folder does not exist yet
      // — `folderId` is null then, and nothing below writes. Skipping them
      // instead reported "5 folders, 0 articles" on the run where the operator
      // most wants the number: the one before the first real seed.
      await upsertArticle(folder.slug, folderId, article, position, { dryRun, overwrite }, tally);
    }
  }

  report(tally, dryRun);
}

async function upsertCategory(dryRun: boolean): Promise<string | null> {
  const existing = await db
    .select({
      id: kbCategories.id,
      name: kbCategories.name,
      description: kbCategories.description,
    })
    .from(kbCategories)
    .where(
      and(
        eq(kbCategories.sourceSystem, 'native'),
        eq(kbCategories.externalId, externalId.category),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const current = existing[0];
    const stale =
      current.name !== HANDBOOK_CATEGORY.name ||
      current.description !== HANDBOOK_CATEGORY.description;

    if (stale && !dryRun) {
      await db
        .update(kbCategories)
        .set({ name: HANDBOOK_CATEGORY.name, description: HANDBOOK_CATEGORY.description })
        .where(eq(kbCategories.id, current.id));
    }
    return current.id;
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
  /** Null only in a dry run, where the category does not exist yet. */
  categoryId: string | null,
  folder: (typeof HANDBOOK)[number],
  position: number,
  dryRun: boolean,
  tally: Tally,
): Promise<string | null> {
  const shape = {
    categoryId: categoryId ?? '',
    name: folder.name,
    description: folder.description,
    // Both, every run. This is the line the feature is built on.
    visibility: 'agents_only' as const,
    minRole: folder.minRole,
    position,
  };

  const existing = await db
    .select({
      id: kbFolders.id,
      categoryId: kbFolders.categoryId,
      name: kbFolders.name,
      description: kbFolders.description,
      visibility: kbFolders.visibility,
      minRole: kbFolders.minRole,
      position: kbFolders.position,
    })
    .from(kbFolders)
    .where(
      and(
        eq(kbFolders.sourceSystem, 'native'),
        eq(kbFolders.externalId, externalId.folder(folder.key)),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const current = existing[0];
    // Compared field by field so a folder that already says what this
    // repository says is not written to at all. See the header: an UPDATE that
    // changes nothing still fires `touch_updated_at`.
    const stale = (Object.keys(shape) as (keyof typeof shape)[]).some(
      (key) => current[key] !== shape[key],
    );

    if (stale) {
      tally.foldersUpdated += 1;
      if (!dryRun && categoryId !== null) {
        await db.update(kbFolders).set(shape).where(eq(kbFolders.id, current.id));
      }
    }
    return current.id;
  }

  tally.foldersCreated += 1;
  if (dryRun || categoryId === null) return null;

  const inserted = await db
    .insert(kbFolders)
    .values({ ...shape, slug: folder.slug, externalId: externalId.folder(folder.key) })
    .returning({ id: kbFolders.id });

  return inserted[0]!.id;
}

async function upsertArticle(
  folderSlug: string,
  /** Null only in a dry run, where the folder does not exist yet. */
  folderId: string | null,
  article: (typeof HANDBOOK)[number]['articles'][number],
  position: number,
  options: { dryRun: boolean; overwrite: boolean },
  tally: Tally,
): Promise<void> {
  // The same pair, in the same order, as every other write path: sanitising is
  // the security boundary and normalising is the formatting pass that relies on
  // being handed the sanitiser's canonical output. `handbook.test.ts` asserts
  // each body is already a fixed point of this, so on a healthy run the pair
  // changes nothing — which is what makes the comparison below meaningful.
  const { bodyHtml, bodyText, excerpt } = articleBody(article.bodyHtml);

  const existing = await db
    .select({
      id: kbArticles.id,
      title: kbArticles.title,
      bodyHtml: kbArticles.bodyHtml,
      folderId: kbArticles.folderId,
      visibility: kbArticles.visibility,
      position: kbArticles.position,
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
  const reached = tally.perFolder.get(folderSlug);
  if (reached) reached.reached += 1;

  if (!row) {
    tally.articlesCreated += 1;
    if (options.dryRun || folderId === null) return;

    await db.insert(kbArticles).values({
      folderId,
      title: article.title,
      slug: article.slug,
      bodyHtml,
      bodyText,
      excerpt,
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

  // Everything this job owns structurally, compared before it is written. The
  // three of them together are the audience guarantee — an article that drifted
  // out of its folder has left the floor behind — but re-asserting values that
  // already hold costs an `updated_at` per row per run.
  const misfiled =
    folderId !== null &&
    (row.folderId !== folderId || row.visibility !== 'agents_only' || row.position !== position);

  if (options.dryRun || (!rewriting && !misfiled)) return;

  await db.transaction(async (tx) => {
    if (rewriting) {
      // The state being replaced, kept where the console's own version history
      // keeps it, so a content push from this repository is undoable from the
      // UI rather than only from a database backup. `edited_by_agent_id` stays
      // null: no agent made this edit.
      await cutArticleVersion(tx, { articleId: row.id, title: row.title, bodyHtml: row.bodyHtml });
    }

    await tx
      .update(kbArticles)
      .set({
        ...(misfiled ? { folderId: folderId!, visibility: 'agents_only' as const, position } : {}),
        ...(rewriting ? { title: article.title, bodyHtml, bodyText, excerpt } : {}),
      })
      .where(eq(kbArticles.id, row.id));
  });
}

function report(tally: Tally, dryRun: boolean): void {
  const log = logger('seed_console_handbook');

  log.info(
    `folders ${tally.foldersCreated} created, ${tally.foldersUpdated} updated ` +
      `(dry_run=${dryRun})`,
  );
  log.info(
    `articles ${tally.articlesCreated} created, ${tally.articlesRewritten} rewritten, ` +
      `${tally.articlesUnchanged} already current`,
  );

  // Named rather than folded into "left alone", because the two mean opposite
  // things. An article that matches this repository needs nothing; one that
  // differs is either somebody's improvement — which is what the console is
  // for — or a content fix in this repository that has not been pushed yet,
  // and only a person can tell those apart.
  if (tally.articlesDrifted > 0) {
    log.info(
      `${tally.articlesDrifted} article(s) differ from this repository and were left ` +
        `as they are; re-run with overwrite=true to replace them`,
    );
  }

  // Per audience rather than as one number, for the reason §7 of the working
  // brief gives about per-locale reporting: "15 articles seeded" reads as a
  // clean run even if the supervisor folder ended up empty, and an audience
  // with nothing addressed to it is exactly the failure worth seeing.
  //
  // Counted as the run reached each article, never read back off `HANDBOOK` —
  // a table printed from the constant that produced the work is an echo, and
  // would show a reassuring three beside a folder the run never got to.
  log.info(`${'audience'.padEnd(16)}${'folder'.padStart(26)}${'reached'.padStart(10)}`);
  for (const [slug, folder] of tally.perFolder) {
    log.info(
      `${folder.minRole.padEnd(16)}${slug.padStart(26)}` + `${String(folder.reached).padStart(10)}`,
    );
  }

  const empty = [...tally.perFolder].filter(([, folder]) => folder.reached === 0);
  if (empty.length > 0) {
    log.info(
      `${empty.length} folder(s) had no article reached: ` + empty.map(([slug]) => slug).join(', '),
    );
  }
}
