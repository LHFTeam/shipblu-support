import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { kbArticles } from '@/db/schema';
import {
  legacyArticleIds,
  legacyArticleIndex,
  legacyArticleResolver,
  rewriteLegacyArticleLinks,
} from './format';
import { withCopiedImages } from './images';

/**
 * A stored article body with every Freshdesk address that has a home here
 * pointed at it: a picture `rehost_kb_images` copied, at its copy, and a link
 * to an article the import brought in, at that article.
 *
 * Every writer of a body that can carry Freshdesk's addresses runs this as it
 * writes — the console's Save and Restore, and the Freshdesk import — so none
 * of them can put back what the copy job and the formatting pass took out. A
 * stale editor tab, a paste from an old copy, a version cut before the copies
 * existed and a re-import from Freshdesk all name Freshdesk, and each now
 * stores the address here. What has no home here is left as it was, for the
 * writer to decide about: the console refuses to add one
 * (`lib/kb/freshdesk-refs.ts`), and the import keeps it for the copy job to
 * find.
 *
 * `bodyHtml` is `articleBody`'s output, and so is the answer: it rewrites one
 * attribute value per address, escaped as the sanitiser escapes one. Neither
 * changes the text `articleBody` derived, which skips pictures and leaves out
 * every `href` (`htmlToText`), so a caller keeps its `bodyText` and `excerpt`.
 *
 * At most two reads on the pool, and none for a body naming nothing of
 * Freshdesk's: called before any transaction, never inside one (§6.91).
 */
export async function pointedHere(bodyHtml: string, locale: string): Promise<string> {
  const withImages = await withCopiedImages(bodyHtml);

  const ids = legacyArticleIds(withImages);
  if (ids.length === 0) return withImages;

  // Only the rows those ids became. `external_id` is `<id>:<locale>`, and the
  // older single-language rows carry the bare id; both split to the id.
  const rows = await db
    .select({ locale: kbArticles.locale, slug: kbArticles.slug, externalId: kbArticles.externalId })
    .from(kbArticles)
    .where(
      and(
        eq(kbArticles.sourceSystem, 'freshdesk'),
        inArray(sql`split_part(${kbArticles.externalId}, ':', 1)`, ids),
      ),
    );

  return rewriteLegacyArticleLinks(
    withImages,
    legacyArticleResolver(legacyArticleIndex(rows), locale),
  );
}
