import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { normaliseKbFormatting } from './normalise-kb-formatting';

/**
 * The pass over stored articles, for the case where the body already meets the
 * standard but the text derived from it does not: stored while `htmlToText`
 * still wrote headings in capitals. Only the derived text is rewritten, and no
 * version row is cut, because the body a version keeps has not changed.
 */

withCleanDatabase();

function job(payload: Record<string, unknown> = {}): ClaimedJob {
  return { id: 'job-1', type: 'normalise_kb_formatting', payload } as unknown as ClaimedJob;
}

async function article(values: { bodyHtml: string; bodyText: string; excerpt: string }) {
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
    .values({ folderId: folder!.id, title: 'Returns', slug: 'returns', ...values })
    .returning({ id: kbArticles.id });
  return row!.id;
}

async function stored(id: string) {
  const [row] = await db
    .select({
      bodyHtml: kbArticles.bodyHtml,
      bodyText: kbArticles.bodyText,
      excerpt: kbArticles.excerpt,
    })
    .from(kbArticles)
    .where(eq(kbArticles.id, id));
  return row;
}

const BODY = '<h2>Returns</h2><p>Book a pickup.</p>';
const SHOUTED = {
  bodyHtml: BODY,
  bodyText: 'RETURNS\n\nBook a pickup.',
  excerpt: 'RETURNS Book a pickup.',
};

describe('normaliseKbFormatting, on text derived in the old form', () => {
  it('rebuilds the text and excerpt, leaves the body alone, and cuts no version', async () => {
    const id = await article(SHOUTED);

    await normaliseKbFormatting(job());

    expect(await stored(id)).toEqual({
      bodyHtml: BODY,
      bodyText: 'Returns\n\nBook a pickup.',
      excerpt: 'Returns Book a pickup.',
    });
    expect(await db.select().from(kbArticleVersions)).toHaveLength(0);
  });

  it('writes nothing on a dry run', async () => {
    const id = await article(SHOUTED);

    await normaliseKbFormatting(job({ dryRun: true }));

    expect(await stored(id)).toEqual(SHOUTED);
  });

  it('leaves an article whose text is already current exactly as it was', async () => {
    const current = {
      bodyHtml: BODY,
      bodyText: 'Returns\n\nBook a pickup.',
      excerpt: 'Returns Book a pickup.',
    };
    const id = await article(current);
    const [before] = await db
      .select({ updatedAt: kbArticles.updatedAt })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));

    await normaliseKbFormatting(job());

    const [after] = await db
      .select({ updatedAt: kbArticles.updatedAt })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    expect(await stored(id)).toEqual(current);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });
});
