import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { POST as feedback } from '@/app/api/kb/feedback/route';
import { db } from '@/db/client';
import { agents, kbArticles, kbCategories, kbFolders, presencePolicy } from '@/db/schema';
import { recordArticleView } from '@/lib/kb/queries';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `touch_updated_at()` from `001_extensions_and_triggers.sql`, against the
 * trigger the file's loop attached.
 *
 * On `kb_articles` the date is an edit date: what readers write — a view, a
 * feedback tap — leaves it alone, and everything else moves it (PROJECT-STATE
 * §6.51). Every other table keeps the plain stamp, which no UPDATE can backdate,
 * because `presence_policy`'s grace period is anchored on it.
 *
 * Each row is inserted with its date in the past, since only an INSERT can put
 * one there, so "moved" and "kept" are told apart by the date itself rather
 * than by how many microseconds separate two statements. The readers are the
 * real ones — `recordArticleView` and the feedback endpoint's `POST` — so a
 * writer that started touching another column would fail here.
 */

withCleanDatabase();

const WRITTEN = new Date('2026-03-01T09:00:00Z');

async function folder(slug = 'shipping'): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: slug, slug, locale: 'en' })
    .returning({ id: kbCategories.id });
  const [row] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: slug, slug, updatedAt: WRITTEN })
    .returning({ id: kbFolders.id });
  return row!.id;
}

async function article(folderId: string): Promise<string> {
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId,
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

async function stored(id: string) {
  const [row] = await db
    .select({
      updatedAt: kbArticles.updatedAt,
      viewCount: kbArticles.viewCount,
      helpfulCount: kbArticles.helpfulCount,
      unhelpfulCount: kbArticles.unhelpfulCount,
      searchVector: sql<string | null>`${kbArticles.searchVector}::text`,
    })
    .from(kbArticles)
    .where(eq(kbArticles.id, id));
  return row!;
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

describe('kb_articles.updated_at', () => {
  it('stays where it was when the article is viewed', async () => {
    const id = await article(await folder());

    await recordArticleView(id);
    await recordArticleView(id);

    const row = await stored(id);
    // The premise: the write happened.
    expect(row.viewCount).toBe(2);
    expect(row.updatedAt).toEqual(WRITTEN);
    // And the generated column is still computed on a row whose date was kept,
    // although `NEW.search_vector` is null inside the trigger.
    expect(row.searchVector).toContain("'pickups'");
  });

  it('stays where it was on a helpful and on an unhelpful tap', async () => {
    const id = await article(await folder());

    await tap(id, true, '203.0.113.1');
    await tap(id, false, '203.0.113.2');

    const row = await stored(id);
    expect(row.helpfulCount).toBe(1);
    expect(row.unhelpfulCount).toBe(1);
    expect(row.updatedAt).toEqual(WRITTEN);
  });

  it('stays where it was on an UPDATE that changes nothing', async () => {
    const id = await article(await folder());

    await db.update(kbArticles).set({ title: 'Pickups' }).where(eq(kbArticles.id, id));

    expect((await stored(id)).updatedAt).toEqual(WRITTEN);
  });

  it('ignores a date an UPDATE writes itself, either way', async () => {
    const id = await article(await folder());

    // Every console writer and the Freshdesk import set `updatedAt: new Date()`
    // beside what they change, so a re-import that only refreshes the counters
    // is this statement, and it is not an edit.
    await db
      .update(kbArticles)
      .set({ viewCount: 500, updatedAt: new Date('2030-01-01T00:00:00Z') })
      .where(eq(kbArticles.id, id));
    expect((await stored(id)).updatedAt).toEqual(WRITTEN);

    // And a backdate on a real edit is the stamp's to replace.
    await db
      .update(kbArticles)
      .set({ title: 'Booking a pickup', updatedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(kbArticles.id, id));
    expect((await stored(id)).updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  const edits: [string, Partial<typeof kbArticles.$inferInsert>][] = [
    ['the title', { title: 'Booking a pickup' }],
    ['the body', { bodyHtml: '<p>Book a pickup online.</p>', bodyText: 'Book a pickup online.' }],
    ['the status', { status: 'archived' }],
    ['the visibility', { visibility: 'agents_only' }],
    ['the tags', { tags: ['pickups'] }],
    ['the position', { position: 3 }],
    ['the reader floor', { minRole: 'supervisor' }],
  ];

  it.each(edits)('moves when %s changes', async (_label, values) => {
    const id = await article(await folder());

    await db.update(kbArticles).set(values).where(eq(kbArticles.id, id));

    expect((await stored(id)).updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it('moves when the article moves to another folder', async () => {
    const id = await article(await folder('shipping'));
    const other = await folder('returns');

    await db.update(kbArticles).set({ folderId: other }).where(eq(kbArticles.id, id));

    expect((await stored(id)).updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it('moves when a counter and the title change in one statement', async () => {
    const id = await article(await folder());

    await db
      .update(kbArticles)
      .set({ viewCount: sql`${kbArticles.viewCount} + 1`, title: 'Booking a pickup' })
      .where(eq(kbArticles.id, id));

    const row = await stored(id);
    expect(row.viewCount).toBe(1);
    expect(row.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
    expect(row.searchVector).toContain("'booking'");
  });
});

describe('every other table', () => {
  it('stamps an agent on an UPDATE that changes nothing', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ email: 'stamp@example.test', name: 'Stamp', updatedAt: WRITTEN })
      .returning({ id: agents.id });

    await db.update(agents).set({ name: 'Stamp' }).where(eq(agents.id, agent!.id));

    const [row] = await db
      .select({ updatedAt: agents.updatedAt })
      .from(agents)
      .where(eq(agents.id, agent!.id));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it('stamps a knowledge-base folder too: the exception is one table, not a prefix', async () => {
    const id = await folder();

    await db.update(kbFolders).set({ slug: 'shipping' }).where(eq(kbFolders.id, id));

    const [row] = await db
      .select({ updatedAt: kbFolders.updatedAt })
      .from(kbFolders)
      .where(eq(kbFolders.id, id));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it('never lets an UPDATE backdate the presence policy, whose grace is anchored on it', async () => {
    await db.insert(presencePolicy).values({ id: 1, updatedAt: WRITTEN });

    await db
      .update(presencePolicy)
      .set({ autoAwayAfterMins: null })
      .where(eq(presencePolicy.id, 1));
    const [unchanged] = await db
      .select({ updatedAt: presencePolicy.updatedAt })
      .from(presencePolicy);
    expect(unchanged!.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());

    await db
      .update(presencePolicy)
      .set({ updatedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(presencePolicy.id, 1));
    const [backdated] = await db
      .select({ updatedAt: presencePolicy.updatedAt })
      .from(presencePolicy);
    expect(backdated!.updatedAt.getTime()).toBeGreaterThanOrEqual(unchanged!.updatedAt.getTime());
  });
});
