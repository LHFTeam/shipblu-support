import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { kbArticleVersions } from '@/db/schema';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from '@/lib/kb/format';

/**
 * What the writers of an article's content share, whoever they are: the
 * console editor, the Freshdesk import, the handbook seed, the formatting pass.
 * Two steps every one of them takes, `articleBody` and `cutArticleVersion`,
 * and one question two of them ask, `changesNothing`.
 *
 * No more than that. The writers' upserts look alike and are not: each keys
 * its rows on a different identity, decides its slug differently, and has its
 * own rule for when a write happens at all. The import overwrites with
 * Freshdesk's version whenever it differs; the handbook leaves an edited
 * article alone. Those rules are each writer's reason for existing, so they
 * stay with the writer. The console's Save and the import ask `changesNothing`
 * before an UPDATE; the handbook seed and the formatting pass compare in their
 * own code, on the fields each owns.
 */

/**
 * What an article row stores for one body: the HTML, the text search reads, and
 * the excerpt listings show, all three from the same pass.
 *
 * Sanitised, then normalised, in that order — `scripts/ci/rules/
 * article-normalisation.mjs` checks the pair, and `lib/kb/format.ts` says why
 * the order matters.
 */
export function articleBody(html: string): { bodyHtml: string; bodyText: string; excerpt: string } {
  const bodyHtml = normaliseArticleHtml(sanitiseArticleHtml(html));
  const bodyText = htmlToText(bodyHtml);
  return { bodyHtml, bodyText, excerpt: preview(bodyText, 200) };
}

/**
 * Whether writing `next` over the stored row `current` would change nothing.
 *
 * Asked before an UPDATE by a writer that may have nothing to say, because
 * `touch_updated_at` stamps every UPDATE of `kb_articles`, one that changes
 * nothing included, and the console's list orders by that date: a Save with
 * nothing edited, or a re-import that finds an article as it was, would float
 * it to the top dated as an edit nobody made (PROJECT-STATE §6.59). Only the
 * columns `next` names are compared, and never `updatedAt`, which is the
 * trigger's: a writer's own stamp is replaced whatever it says, so it is no
 * reason to write. A key holding `undefined` is one Drizzle leaves out of the
 * SET, so it is no change either. Arrays compare in order, since `tags` is
 * stored as typed, and objects by their keys, as jsonb compares them.
 */
export function changesNothing(
  current: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(next).every(
    ([key, value]) => key === 'updatedAt' || value === undefined || same(current[key], value),
  );
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => same(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Keeps the state an article is about to lose, as its next version.
 *
 * Called inside the transaction that replaces it: the number is read from the
 * rows already there, and `kb_article_versions_article_version_idx` refuses a
 * second writer that read the same one rather than letting both land.
 */
export async function cutArticleVersion(
  tx: typeof db,
  replaced: {
    articleId: string;
    title: string;
    bodyHtml: string;
    /** Absent when no agent made the edit. */
    editedByAgentId?: string;
  },
): Promise<void> {
  const next = await tx
    .select({ version: sql<number>`coalesce(max(${kbArticleVersions.version}), 0) + 1` })
    .from(kbArticleVersions)
    .where(eq(kbArticleVersions.articleId, replaced.articleId));

  await tx.insert(kbArticleVersions).values({ ...replaced, version: next[0]?.version ?? 1 });
}
