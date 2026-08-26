import { publicBaseUrl } from '@/lib/kb/site';

export const dynamic = 'force-dynamic';

export async function GET() {
  const base = publicBaseUrl();

  return new Response(
    [
      'User-agent: *',
      'Allow: /',
      // Thin, infinite, and competing with the articles they link to.
      'Disallow: /*/search',
      // Every useful URL here carries somebody's parcel number. The page also
      // sends `noindex`; this is the half that keeps the number out of a
      // crawler's logs rather than only out of its index.
      'Disallow: /*/track',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain' } },
  );
}
