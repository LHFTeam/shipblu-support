import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Restoring an article version writes every column the body feeds. The
 * restore used to set the body and its search text but not the excerpt, so a
 * listing kept showing the opening line of the body it had just replaced.
 *
 * And a Save with nothing edited writes nothing: `touch_updated_at` stamps every
 * UPDATE, one that changes nothing included, so a written no-op would float the
 * article to the top of `/kb`. Read off `xmin`, which any write moves.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));

vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: signedIn.id, role: 'admin' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { restoreVersion, saveArticle } = await import('./actions');

withCleanDatabase();

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function article(bodyHtml: string, excerpt: string) {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;

  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Shipping', slug: 'shipping' })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Delivery', slug: 'delivery' })
    .returning({ id: kbFolders.id });
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId: folder!.id,
      title: 'Current title',
      slug: 'current',
      bodyHtml,
      bodyText: 'Current body text.',
      excerpt,
    })
    .returning({ id: kbArticles.id });
  return row!.id;
}

describe('restoreVersion', () => {
  it('rebuilds the excerpt from the restored body', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    const [version] = await db
      .insert(kbArticleVersions)
      .values({
        articleId: id,
        version: 1,
        title: 'Old title',
        bodyHtml: '<p>The body this article had before.</p>',
      })
      .returning({ id: kbArticleVersions.id });

    const state = await restoreVersion({ error: null }, form({ id, versionId: version!.id }));
    expect(state.error).toBeNull();

    const [restored] = await db
      .select({
        title: kbArticles.title,
        bodyText: kbArticles.bodyText,
        excerpt: kbArticles.excerpt,
      })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));

    expect(restored).toEqual({
      title: 'Old title',
      bodyText: 'The body this article had before.',
      excerpt: 'The body this article had before.',
    });
  });
});

describe('saveArticle', () => {
  /** The editor's form for the article as the fixture writes it. */
  async function editorForm(id: string, overrides: Record<string, string> = {}) {
    const [row] = await db
      .select({ folderId: kbArticles.folderId })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return form({
      id,
      title: 'Current title',
      folderId: row!.folderId,
      locale: 'en',
      bodyHtml: '<p>Current body text.</p>',
      visibility: 'public',
      slug: 'current',
      seoTitle: '',
      seoDescription: '',
      tags: 'pickup, courier',
      ...overrides,
    });
  }

  async function written(id: string) {
    const [row] = await db
      .select({ xmin: sql<string>`xmin::text`, updatedAt: kbArticles.updatedAt })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return row!;
  }

  it('writes nothing when nothing was edited, and answers a success', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    // The first save writes what the form holds that the fixture did not, the
    // tags among them; the second finds the row as the form says.
    expect((await saveArticle({ error: null }, await editorForm(id))).error).toBeNull();
    const before = await written(id);

    const state = await saveArticle({ error: null }, await editorForm(id));

    expect(state.error).toBeNull();
    expect(await written(id)).toEqual(before);
  });

  it('writes the row when one field differs', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    await saveArticle({ error: null }, await editorForm(id));
    const before = await written(id);

    await saveArticle({ error: null }, await editorForm(id, { tags: 'pickup' }));

    expect((await written(id)).xmin).not.toBe(before.xmin);
    const [row] = await db
      .select({ tags: kbArticles.tags })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    expect(row!.tags).toEqual(['pickup']);
  });
});
