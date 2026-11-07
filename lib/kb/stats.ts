import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticleFeedback, kbArticleStats, kbArticles } from '@/db/schema';
import { isForeignKeyViolation } from '@/lib/db/errors';

/**
 * What readers do to an article — opening it, and saying whether it helped —
 * counted in `kb_article_stats`, beside the article rather than on it.
 *
 * On the article's own row every view rewrote the whole row, its stored
 * `search_vector` regenerated from the title and the body each time, and took
 * the row lock a console save waits on (PROJECT-STATE §6.51). Here a view
 * writes one narrow row that no console edit writes or locks. An article's
 * first view inserts that row, and the insert's foreign-key check takes a KEY
 * SHARE lock on the article for the length of the statement. Only a delete,
 * or an edit changing a column under one of the table's unique keys, waits on
 * that: a console save that changes the slug or the locale, or the Freshdesk
 * import re-keying an article's external id. Every later view updates the
 * stats row alone and leaves the article's row untouched.
 *
 * Every write that counts is in this module. The article's own columns of the
 * same names were copied here and dropped (`plans/kb-article-stats.md`).
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `kb_article_stats.article_id`'s foreign key, as migration 0057 named it. */
const STATS_ARTICLE_FK = 'kb_article_stats_article_id_kb_articles_id_fk';

/** `kb_article_feedback.article_id`'s, as migration 0000 named it. */
const FEEDBACK_ARTICLE_FK = 'kb_article_feedback_article_id_kb_articles_id_fk';

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
 * One reader said the article helped, or did not: the `kb_article_feedback`
 * row, with its comment, and one more on the matching counter.
 *
 * In one transaction, so a vote's count and its feedback row are stored
 * together or not at all. The counters are not a count of those rows: they
 * also carry Freshdesk's totals (`setArticleStats`).
 *
 * The feedback endpoint reads the article first and answers a vote on one
 * already gone without calling this. An article deleted after that read, while
 * the vote is on its way in, meets the feedback row's foreign key or the
 * counter's, and that is answered as though the delete had come first — the
 * endpoint's 204 — as `recordArticleView` answers the same race.
 */
export async function recordArticleVote(
  articleId: string,
  wasHelpful: boolean,
  comment: string | null,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(kbArticleFeedback).values({ articleId, wasHelpful, comment });
      await tx
        .insert(kbArticleStats)
        .values(wasHelpful ? { articleId, helpfulCount: 1 } : { articleId, unhelpfulCount: 1 })
        .onConflictDoUpdate({
          target: kbArticleStats.articleId,
          set: wasHelpful
            ? { helpfulCount: sql`${kbArticleStats.helpfulCount} + 1` }
            : { unhelpfulCount: sql`${kbArticleStats.unhelpfulCount} + 1` },
        });
    });
  } catch (error) {
    if (
      isForeignKeyViolation(error, FEEDBACK_ARTICLE_FK) ||
      isForeignKeyViolation(error, STATS_ARTICLE_FK)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * The counters as another system counted them: the Freshdesk import's, so
 * "most read" ordering does not reset to zero on cutover.
 *
 * Each counter takes the greater of what is here and what Freshdesk says,
 * never the sum and never Freshdesk's alone. A re-import carries Freshdesk's
 * running totals, which already include what the last import carried, so
 * adding would count them twice. Replacing, as the import once did, threw
 * away every view and vote counted here since cutover, which start from
 * Freshdesk's totals and only grow — and zeroed a translation, whose payload
 * usually carries no counts at all. The greater is Freshdesk's on a rehearsal,
 * where its totals are the ones still growing, and ours after cutover.
 */
export async function setArticleStats(
  tx: Executor,
  articleId: string,
  counts: { viewCount: number; helpfulCount: number; unhelpfulCount: number },
): Promise<void> {
  await tx
    .insert(kbArticleStats)
    .values({ articleId, ...counts })
    .onConflictDoUpdate({
      target: kbArticleStats.articleId,
      set: {
        viewCount: sql`greatest(${kbArticleStats.viewCount}, excluded.view_count)`,
        helpfulCount: sql`greatest(${kbArticleStats.helpfulCount}, excluded.helpful_count)`,
        unhelpfulCount: sql`greatest(${kbArticleStats.unhelpfulCount}, excluded.unhelpful_count)`,
      },
    });
}
