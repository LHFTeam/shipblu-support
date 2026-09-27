import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { kbArticleVersions } from '@/db/schema';
import { htmlToText, preview, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from '@/lib/kb/format';

/**
 * The two steps every write of an article's content shares, whoever makes it:
 * the console editor, the Freshdesk import, the handbook seed, the formatting
 * pass.
 *
 * Only these two. The writers' upserts look alike and are not: each keys its
 * rows on a different identity, decides its slug differently, and has its own
 * rule for when a write happens at all — the import overwrites what Freshdesk
 * says every run, the handbook compares first and leaves an edited article
 * alone. Those rules are each writer's reason for existing, so they stay with
 * the writer; what is shared here is what none of them has a reason to vary.
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
