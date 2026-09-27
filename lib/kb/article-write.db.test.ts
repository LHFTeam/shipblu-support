import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { agents, kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { cutArticleVersion } from './article-write';

/**
 * The version history the console editor, its restore button, the handbook
 * seed and the formatting pass all write through. None of the four is reached
 * by another database test, and the handbook's CI step asserts that its second
 * run cuts no version at all — so without this, numbering was checked nowhere.
 */

withCleanDatabase();

async function article(slug: string): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: slug, slug })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: slug, slug })
    .returning({ id: kbFolders.id });
  const [row] = await db
    .insert(kbArticles)
    .values({ folderId: folder!.id, title: slug, slug })
    .returning({ id: kbArticles.id });
  return row!.id;
}

async function versions(articleId: string) {
  return db
    .select({
      version: kbArticleVersions.version,
      title: kbArticleVersions.title,
      bodyHtml: kbArticleVersions.bodyHtml,
      editedByAgentId: kbArticleVersions.editedByAgentId,
    })
    .from(kbArticleVersions)
    .where(eq(kbArticleVersions.articleId, articleId))
    .orderBy(asc(kbArticleVersions.version));
}

describe('cutArticleVersion', () => {
  it('numbers each article from one, and records who made the edit when somebody did', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ email: 'editor@shipblu.test', name: 'Editor' })
      .returning({ id: agents.id });
    const first = await article('first');
    const second = await article('second');

    await db.transaction(async (tx) => {
      await cutArticleVersion(tx, { articleId: first, title: 'One', bodyHtml: '<p>1</p>' });
    });
    await db.transaction(async (tx) => {
      await cutArticleVersion(tx, {
        articleId: first,
        title: 'Two',
        bodyHtml: '<p>2</p>',
        editedByAgentId: agent!.id,
      });
    });
    await db.transaction(async (tx) => {
      await cutArticleVersion(tx, { articleId: second, title: 'Other', bodyHtml: '<p>x</p>' });
    });

    expect(await versions(first)).toEqual([
      { version: 1, title: 'One', bodyHtml: '<p>1</p>', editedByAgentId: null },
      { version: 2, title: 'Two', bodyHtml: '<p>2</p>', editedByAgentId: agent!.id },
    ]);
    expect(await versions(second)).toEqual([
      { version: 1, title: 'Other', bodyHtml: '<p>x</p>', editedByAgentId: null },
    ]);
  });
});
