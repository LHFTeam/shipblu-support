import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleStats, kbArticles } from '@/db/schema';
import { isForeignKeyViolation } from '@/lib/db/errors';

/**
 * What readers do to an article — opening it, and saying whether it helped —
 * counted in `kb_article_stats`, beside the article rather than on it.
 *
 * On the article's own row every view rewrote the whole row, its stored
 * `search_vector` regenerated from the title and the body each time, and took
 * the row lock a console save waits on (PROJECT-STATE §6.51). Here a view
 * writes one narrow row that no edit writes or locks. An article's first view
 * inserts that row, and the insert's foreign-key check takes a KEY SHARE lock
 * on the article for the length of the statement, which a save waits on only
 * when it changes the slug or the locale (a key a foreign key could name), and
 * a delete always; every later view updates the stats row alone and leaves the
 * article's row untouched.
 *
 * Every writer of the counters is in this module, so nothing writes the three
 * columns of the same names still on `kb_articles`, which the release after
 * this one drops (`plans/kb-article-stats.md`).
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `kb_article_stats.article_id`'s foreign key, as migration 0057 named it. */
const STATS_ARTICLE_FK = 'kb_article_stats_article_id_kb_articles_id_fk';

/**
 * The join from an article to its counters. Always a left join where the
 * article is listed whatever its counts: nothing creates a row when the article
 * is written, so one nobody has opened or rated usually has none.
 */
export const statsOfArticle = eq(kbArticleStats.articleId, kbArticles.id);

/** The counters through `statsOfArticle`, a missing row reading as zero. */
export const articleViews = sql<number>`coalesce(${kbArticleStats.viewCount}, 0)`;
export const articleHelpful = sql<number>`coalesce(${kbArticleStats.helpfulCount}, 0)`;
export const articleUnhelpful = sql<number>`coalesce(${kbArticleStats.unhelpfulCount}, 0)`;

/** The three counters as the console shows them. */
export type ArticleStats = { views: number; helpful: number; unhelpful: number };

/**
 * One reader opened the article.
 *
 * A plain increment, with no per-visitor deduplication: this drives "most
 * read" ordering for the team, not billing, and the alternative is a visitor
 * table and a cookie on a site that otherwise sets none.
 *
 * Inserted from a read of the article rather than from the id it was handed,
 * so a view of an article that no longer exists — a page left open while it
 * was deleted, or an invented id — inserts nothing and raises no foreign-key
 * error, as the UPDATE on the article's row it replaces did nothing. The read
 * takes no lock: a stats row that already exists is an update of its own
 * counter, and Postgres skips the foreign-key check on an update that leaves
 * the key alone.
 *
 * Which leaves one way to meet the foreign key: a delete of the article
 * committing while this statement is between its read and its check, or
 * while it waits on the stats row the delete's cascade is removing. That is
 * answered as though the delete had come first, which is what the UPDATE it
 * replaces answered, rather than as a 500 to a beacon nobody reads.
 */
export async function recordArticleView(articleId: string): Promise<void> {
  try {
    await db
      .insert(kbArticleStats)
      .select(
        db
          .select({
            articleId: kbArticles.id,
            viewCount: sql<number>`1`.as('view_count'),
            helpfulCount: sql<number>`0`.as('helpful_count'),
            unhelpfulCount: sql<number>`0`.as('unhelpful_count'),
          })
          .from(kbArticles)
          .where(eq(kbArticles.id, articleId)),
      )
      .onConflictDoUpdate({
        target: kbArticleStats.articleId,
        set: { viewCount: sql`${kbArticleStats.viewCount} + 1` },
      });
  } catch (error) {
    if (isForeignKeyViolation(error, STATS_ARTICLE_FK)) return;
    throw error;
  }
}

/**
 * One reader said the article helped, or did not.
 *
 * Takes the transaction its caller writes the `kb_article_feedback` row in, so
 * the counters can never disagree with the rows they summarise. The caller
 * has read the article first, and the feedback row's own foreign key refuses
 * one gone since, so this inserts from the id rather than from a read.
 */
export async function countArticleVote(
  tx: Executor,
  articleId: string,
  wasHelpful: boolean,
): Promise<void> {
  await tx
    .insert(kbArticleStats)
    .values(wasHelpful ? { articleId, helpfulCount: 1 } : { articleId, unhelpfulCount: 1 })
    .onConflictDoUpdate({
      target: kbArticleStats.articleId,
      set: wasHelpful
        ? { helpfulCount: sql`${kbArticleStats.helpfulCount} + 1` }
        : { unhelpfulCount: sql`${kbArticleStats.unhelpfulCount} + 1` },
    });
}

/**
 * The counters as another system counted them, replacing whatever is here.
 *
 * The Freshdesk import's, so "most read" ordering does not reset to zero on
 * cutover. Replacing rather than adding, because a re-import carries
 * Freshdesk's running totals, which already include what the last one carried.
 */
export async function setArticleStats(
  tx: Executor,
  articleId: string,
  counts: { viewCount: number; helpfulCount: number; unhelpfulCount: number },
): Promise<void> {
  await tx
    .insert(kbArticleStats)
    .values({ articleId, ...counts })
    .onConflictDoUpdate({ target: kbArticleStats.articleId, set: counts });
}
