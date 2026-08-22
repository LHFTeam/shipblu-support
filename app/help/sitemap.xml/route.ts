import { LOCALES } from '@/lib/kb/locale';
import { allPublishedArticles, listCategories } from '@/lib/kb/queries';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { publicBaseUrl } from '@/lib/kb/site';

export const dynamic = 'force-dynamic';

/**
 * Hand-written rather than Next's `sitemap.ts` convention, because the file
 * lives under a rewritten path: the convention would emit URLs containing
 * `/kb`, which is an internal detail no customer or crawler ever sees.
 */
export async function GET() {
  const base = publicBaseUrl();

  // Anonymous on purpose. A sitemap is fetched by crawlers and by anyone who
  // asks for the URL, so it must list only what an anonymous reader can open —
  // a `logged_in` article named here would be advertised to the open web by the
  // one file whose job is telling Google what to index.
  const [articles, ...categoriesByLocale] = await Promise.all([
    allPublishedArticles(),
    ...LOCALES.map((locale) => listCategories(ANONYMOUS, locale)),
  ]);

  const urls: { loc: string; lastmod?: string; priority: string }[] = [];

  LOCALES.forEach((locale, index) => {
    urls.push({ loc: `${base}/${locale}`, priority: '1.0' });
    for (const category of categoriesByLocale[index] ?? []) {
      urls.push({ loc: `${base}/${locale}/c/${encodeURI(category.slug)}`, priority: '0.7' });
    }
  });

  for (const article of articles) {
    urls.push({
      loc: `${base}/${article.locale}/a/${encodeURI(article.slug)}`,
      lastmod: article.updatedAt.toISOString(),
      priority: '0.5',
    });
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((url) =>
      [
        '  <url>',
        `    <loc>${escapeXml(url.loc)}</loc>`,
        url.lastmod ? `    <lastmod>${url.lastmod}</lastmod>` : '',
        `    <priority>${url.priority}</priority>`,
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
