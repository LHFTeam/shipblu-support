import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as feedback } from '@/app/api/kb/feedback/route';
import { db } from '@/db/client';
import {
  kbArticleFeedback,
  kbArticleStats,
  kbArticles,
  kbCategories,
  kbFolders,
} from '@/db/schema';
import { recordArticleView } from '@/lib/kb/stats';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The knowledge base's two reader writes — a view and a "Was this helpful?"
 * tap — land in `kb_article_stats` and never on the article's own row.
 *
 * The writers are the real ones, `recordArticleView` and the feedback
 * endpoint's `POST`, so a writer that started touching the article again fails
 * here. "Never on the
 * article's row" is read off `xmin`, the transaction that wrote the row's
 * current version: an UPDATE that changed nothing, which `touch_updated_at`
 * would leave dated as it was, still moves it. Here rather than in `lib/kb/`
 * because the feedback endpoint is a route, and `lib/` may not import one.
 */

withCleanDatabase();

const WRITTEN = new Date('2026-03-01T09:00:00Z');
const MISSING = '00000000-0000-4000-8000-0000000000aa';

async function article(): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Shipping', slug: 'shipping', locale: 'en' })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Pickups', slug: 'pickups' })
    .returning({ id: kbFolders.id });
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId: folder!.id,
      title: 'Pickups',
      slug: 'pickups',
      bodyHtml: '<p>Book a pickup.</p>',
      bodyText: 'Book a pickup.',
      locale: 'en',
      status: 'published',
      visibility: 'public',
      publishedAt: WRITTEN,
      updatedAt: WRITTEN,
    })
    .returning({ id: kbArticles.id });
  return row!.id;
}

/** The article's row as last written: the version's writer, and its date. */
async function written(id: string) {
  const [row] = await db
    .select({ xmin: sql<string>`xmin::text`, updatedAt: kbArticles.updatedAt })
    .from(kbArticles)
    .where(eq(kbArticles.id, id));
  return row!;
}

async function stats(id: string) {
  const [row] = await db
    .select({
      viewCount: kbArticleStats.viewCount,
      helpfulCount: kbArticleStats.helpfulCount,
      unhelpfulCount: kbArticleStats.unhelpfulCount,
    })
    .from(kbArticleStats)
    .where(eq(kbArticleStats.articleId, id));
  return row ?? null;
}

/** A tap on "Was this helpful?", as the help centre's article page sends it. */
async function tap(articleId: string, wasHelpful: boolean, ip: string): Promise<void> {
  const response = await feedback(
    new Request('http://help.test/api/kb/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ articleId, wasHelpful }),
    }),
  );
  expect(response.status).toBe(204);
}

describe('a view', () => {
  it('creates the stats row, then adds to it, and never writes the article', async () => {
    const id = await article();
    const before = await written(id);
    expect(await stats(id)).toBeNull();

    await recordArticleView(id);
    expect(await stats(id)).toEqual({ viewCount: 1, helpfulCount: 0, unhelpfulCount: 0 });

    await recordArticleView(id);
    await recordArticleView(id);
    expect(await stats(id)).toEqual({ viewCount: 3, helpfulCount: 0, unhelpfulCount: 0 });

    expect(await written(id)).toEqual(before);
    expect(before.updatedAt).toEqual(WRITTEN);
  });

  it('of an article that does not exist does nothing, and does not throw', async () => {
    await expect(recordArticleView(MISSING)).resolves.toBeUndefined();

    expect(await db.select().from(kbArticleStats)).toEqual([]);
  });

  /**
   * The one way a view can still meet the foreign key: the article's delete
   * commits while the view is between reading the article and checking the
   * key (`whileDeleting`). Answered as though the delete had come first, as the
   * UPDATE it replaced answered. The second case is the same race met through the
   * cascade: the view's upsert waits on the stats row the delete is removing.
   */
  it.each([
    ['its first view', false],
    ['a later view', true],
  ])('racing the delete of its article does nothing, on %s', async (_label, seen) => {
    const id = await article();
    if (seen) await recordArticleView(id);

    await expect(whileDeleting(id, () => recordArticleView(id))).resolves.toBeUndefined();

    expect(await db.select().from(kbArticleStats)).toEqual([]);
  });
});

describe('a feedback tap', () => {
  it('counts into the stats row beside its feedback row, and never writes the article', async () => {
    const id = await article();
    const before = await written(id);

    await tap(id, true, '203.0.113.11');
    expect(await stats(id)).toEqual({ viewCount: 0, helpfulCount: 1, unhelpfulCount: 0 });

    await tap(id, false, '203.0.113.12');
    await tap(id, true, '203.0.113.13');
    expect(await stats(id)).toEqual({ viewCount: 0, helpfulCount: 2, unhelpfulCount: 1 });

    const votes = await db
      .select({ wasHelpful: kbArticleFeedback.wasHelpful })
      .from(kbArticleFeedback)
      .where(eq(kbArticleFeedback.articleId, id));
    expect(votes.map((vote) => vote.wasHelpful).sort()).toEqual([false, true, true]);

    expect(await written(id)).toEqual(before);
  });

  it('adds to the row a view created, rather than starting another', async () => {
    const id = await article();

    await recordArticleView(id);
    await tap(id, false, '203.0.113.21');

    expect(await stats(id)).toEqual({ viewCount: 1, helpfulCount: 0, unhelpfulCount: 1 });
  });

  /**
   * The endpoint reads the article before it writes, so the race is the
   * article's delete committing after that read, while the feedback row's
   * foreign key waits on it — and the answer is the 204 a vote on an article
   * already gone gets, with nothing written.
   */
  it('racing the delete of its article answers 204 and writes nothing', async () => {
    const id = await article();
    await recordArticleView(id);

    await whileDeleting(id, () => tap(id, true, '203.0.113.41'));

    expect(await db.select().from(kbArticleFeedback)).toEqual([]);
    expect(await db.select().from(kbArticleStats)).toEqual([]);
  });

  it('for an article that does not exist writes nothing', async () => {
    await tap(MISSING, true, '203.0.113.31');

    expect(await db.select().from(kbArticleStats)).toEqual([]);
    expect(await db.select().from(kbArticleFeedback)).toEqual([]);
  });
});

/**
 * Runs `write` while the article's delete is held open, and answers what it
 * answered once the delete has committed.
 *
 * Held so the order is certain: the delete has run and holds the article's
 * row, `write` starts and reads the article as it was before the delete, and
 * only once `write` is waiting on that row is the delete let commit.
 */
async function whileDeleting<T>(id: string, write: () => Promise<T>): Promise<T> {
  let deleted!: () => void;
  let release!: () => void;
  const didDelete = new Promise<void>((resolve) => (deleted = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const deleting = db.transaction(async (tx) => {
    await tx.delete(kbArticles).where(eq(kbArticles.id, id));
    deleted();
    await held;
  });
  await didDelete;

  const writing = write();
  try {
    await waitForALockWait();
  } finally {
    // Whatever the wait found, so a failed one does not leave the delete
    // holding the article's row lock past the end of the test.
    release();
    await deleting;
  }
  return writing;
}

/**
 * Until a backend of this database is waiting on a lock, for about two seconds
 * at most: well inside the test's own five, so a view that never waited fails
 * with this sentence rather than with a timeout.
 */
async function waitForALockWait(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no backend ever waited on a lock');
}
