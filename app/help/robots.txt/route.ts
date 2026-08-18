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
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n'),
    { headers: { 'Content-Type': 'text/plain' } },
  );
}
