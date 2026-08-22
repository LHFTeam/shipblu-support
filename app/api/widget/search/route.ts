import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { searchArticles } from '@/lib/kb/queries';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { allow, clientIp } from '@/lib/kb/rate-limit';
import { publicBaseUrl } from '@/lib/kb/site';

export const dynamic = 'force-dynamic';

/**
 * Article suggestions inside the widget.
 *
 * Answering in the widget is cheaper than answering in a ticket, and it is the
 * one deflection mechanism that does not feel like being fobbed off — the
 * visitor asked, and got an answer, without waiting.
 *
 * Reuses the public search, so it inherits the same visibility rule: a draft or
 * an agents-only article cannot be suggested here.
 *
 * Anonymous, always. The widget authenticates a *visitor* — a token minted for
 * a browser on somebody else's website — which is not the portal session that
 * says who a customer is. Treating one as the other would hand a `logged_in`
 * article to any page that embeds the widget. A signed-in customer searching
 * from the help centre gets their own articles through the search page, which
 * has their session.
 */
export async function GET(request: Request) {
  if (!allow(`widget-search:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ articles: [] }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  const requested = params.get('locale') ?? DEFAULT_LOCALE;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  if (query.length < 3) return NextResponse.json({ articles: [] });

  const hits = await searchArticles(ANONYMOUS, locale, query, 3);
  const base = publicBaseUrl();

  return NextResponse.json({
    articles: hits.map((hit) => ({
      title: hit.title,
      url: `${base}/${locale}/a/${encodeURI(hit.slug)}`,
    })),
  });
}
