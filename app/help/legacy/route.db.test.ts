import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbRedirects } from '@/db/schema';
import { LEGACY_PATH_HEADER } from '@/lib/kb/legacy-path';
import { withCleanDatabase } from '@/lib/testing/db';
import { GET } from './route';

/**
 * The Freshdesk URL redirect, against real Postgres, fed the request Next
 * actually hands it.
 *
 * Measured on a production build (2026-11-08): after the proxy's rewrite to
 * `/help/legacy`, the handler's `request.url` is the URL as it arrived —
 * `/support/solutions/articles/<id>`, with no `?path=` — and what the proxy
 * passes reaches it only as a request header. So `rewritten()` below builds
 * that request, and before the header existed every case through it answered
 * 404, while the same route called with `?path=` answered 301
 * (PROJECT-STATE §6.115). `directly()` is that second call, which stays.
 */

withCleanDatabase();

const ORIGIN = 'https://shipblu-support.onrender.com';
const ARTICLE = '154000189336';
const FOLDER = '154000050001';

/** As Next hands it to the handler after the proxy's rewrite. */
const rewritten = (path: string) =>
  GET(new Request(`${ORIGIN}${path}`, { headers: { [LEGACY_PATH_HEADER]: path } }));

/** The route called by its own URL, as an operator or the audit does. */
const directly = (path: string) =>
  GET(new Request(`${ORIGIN}/help/legacy?path=${encodeURIComponent(path)}`));

const location = (response: Response) => decodeURI(response.headers.get('location') ?? '');

async function fixtures() {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'الشحن', slug: 'shipping', locale: 'ar' })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({
      categoryId: category!.id,
      name: 'التعبئة',
      slug: 'packing',
      sourceSystem: 'freshdesk',
      externalId: `${FOLDER}:ar`,
    })
    .returning({ id: kbFolders.id });
  const rows = await db
    .insert(kbArticles)
    .values(
      [
        { locale: 'ar', slug: 'إرشادات-التعبئة-والتغليف', title: 'إرشادات التعبئة والتغليف' },
        { locale: 'en', slug: 'packaging-guidelines', title: 'Packaging guidelines' },
      ].map((article) => ({
        ...article,
        folderId: folder!.id,
        status: 'published' as const,
        sourceSystem: 'freshdesk' as const,
        externalId: `${ARTICLE}:${article.locale}`,
      })),
    )
    .returning({ id: kbArticles.id, locale: kbArticles.locale });
  return { english: rows.find((row) => row.locale === 'en')!.id };
}

describe('GET /help/legacy', () => {
  it('redirects every article shape the proxy rewrites, permanently', async () => {
    await fixtures();

    for (const path of [
      `/support/solutions/articles/${ARTICLE}`,
      `/support/solutions/articles/${ARTICLE}-packaging-guidelines`,
      `/a/solutions/articles/${ARTICLE}`,
      `/solutions/articles/${ARTICLE}`,
    ]) {
      const response = await rewritten(path);
      expect(response.status, path).toBe(301);
      // Arabic is the default locale, and the path names no language.
      expect(location(response), path).toBe('/ar/a/إرشادات-التعبئة-والتغليف');
    }
  });

  it('takes the language a Freshdesk portal URL names', async () => {
    await fixtures();
    const response = await rewritten(`/en/support/solutions/articles/${ARTICLE}`);
    expect(response.status).toBe(301);
    expect(location(response)).toBe('/en/a/packaging-guidelines');
  });

  it('sends a folder to the help centre home', async () => {
    await fixtures();
    const response = await rewritten(`/support/solutions/folders/${FOLDER}`);
    expect(response.status).toBe(301);
    expect(location(response)).toBe('/ar');
  });

  it('follows a kb_redirects row before the article id', async () => {
    const { english } = await fixtures();
    await db
      .insert(kbRedirects)
      .values({ fromPath: `/support/solutions/articles/${ARTICLE}`, articleId: english });
    const response = await rewritten(`/support/solutions/articles/${ARTICLE}`);
    expect(location(response)).toBe('/en/a/packaging-guidelines');
  });

  it('answers 404 for an id nothing was imported as', async () => {
    await fixtures();
    expect((await rewritten('/support/solutions/articles/999')).status).toBe(404);
    expect((await rewritten('/support/solutions/folders/999')).status).toBe(404);
  });

  it('still answers a direct call with ?path=', async () => {
    await fixtures();
    const response = await directly(`/support/solutions/articles/${ARTICLE}`);
    expect(response.status).toBe(301);
    expect(location(response)).toBe('/ar/a/إرشادات-التعبئة-والتغليف');
  });

  it('answers 404, not a guess, for a request that names no path at all', async () => {
    // What the rewritten request looked like to the handler before the header.
    await fixtures();
    expect((await GET(new Request(`${ORIGIN}/support/solutions/articles/${ARTICLE}`))).status).toBe(
      404,
    );
  });
});
