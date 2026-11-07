import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, kbArticles, kbCategories, kbFolders, presencePolicy } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `touch_updated_at()` from `001_extensions_and_triggers.sql`, against the
 * trigger the file's loop attached.
 *
 * It stamps `now()` on every UPDATE of every table, one that changes nothing
 * included, and no UPDATE can backdate it — `presence_policy`'s grace period
 * is anchored on that. `kb_articles` is held to it here because it was the one
 * exception, from #466 until its reader counters were dropped
 * (`plans/kb-article-stats.md`): the exception kept the date on an UPDATE that
 * changed nothing but a counter, or nothing at all. Readers now count in
 * `kb_article_stats` and never write the article, which
 * `app/api/kb/stats.db.test.ts` holds them to by the row's `xmin`.
 *
 * Each row is inserted with its date in the past, since only an INSERT can put
 * one there, so "moved" and "kept" are told apart by the date itself rather
 * than by how many microseconds separate two statements.
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

async function article(folderId: string, slug = 'pickups'): Promise<string> {
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId,
      title: 'Pickups',
      slug,
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

async function articleDate(id: string): Promise<Date> {
  const [row] = await db
    .select({ updatedAt: kbArticles.updatedAt })
    .from(kbArticles)
    .where(eq(kbArticles.id, id));
  return row!.updatedAt;
}

describe('touch_updated_at', () => {
  it('stamps an article on an UPDATE that changes nothing, as every table', async () => {
    const id = await article(await folder());

    await db.update(kbArticles).set({ title: 'Pickups' }).where(eq(kbArticles.id, id));

    expect((await articleDate(id)).getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it('replaces a date an UPDATE writes into an article, either way', async () => {
    const folderId = await folder();
    const ahead = await article(folderId, 'ahead');
    const behind = await article(folderId, 'behind');
    const future = new Date('9999-01-01T00:00:00Z');

    await db
      .update(kbArticles)
      .set({ title: 'Booking a pickup', updatedAt: future })
      .where(eq(kbArticles.id, ahead));
    await db
      .update(kbArticles)
      .set({ updatedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(kbArticles.id, behind));

    const forward = await articleDate(ahead);
    expect(forward.getTime()).toBeGreaterThan(WRITTEN.getTime());
    expect(forward.getTime()).toBeLessThan(future.getTime());
    // Neither backdated nor kept at the date it was written with: the UPDATE
    // that wrote nothing else was stamped like any other.
    expect((await articleDate(behind)).getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

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

  it('stamps a knowledge-base folder on an UPDATE that changes nothing', async () => {
    const id = await folder();

    await db.update(kbFolders).set({ slug: 'shipping' }).where(eq(kbFolders.id, id));

    const [row] = await db
      .select({ updatedAt: kbFolders.updatedAt })
      .from(kbFolders)
      .where(eq(kbFolders.id, id));
    expect(row!.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
  });

  it.each<[string, Partial<typeof presencePolicy.$inferInsert>]>([
    ['changes nothing', { autoAwayAfterMins: null }],
    ['tries to backdate it', { updatedAt: new Date('2000-01-01T00:00:00Z') }],
  ])(
    'stamps the presence policy, whose grace is anchored on it, on an UPDATE that %s',
    async (_label, values) => {
      await db.insert(presencePolicy).values({ id: 1, updatedAt: WRITTEN });

      await db.update(presencePolicy).set(values).where(eq(presencePolicy.id, 1));

      const [row] = await db.select({ updatedAt: presencePolicy.updatedAt }).from(presencePolicy);
      expect(row!.updatedAt.getTime()).toBeGreaterThan(WRITTEN.getTime());
    },
  );
});
