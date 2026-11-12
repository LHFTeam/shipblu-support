import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { searchArticles } from '@/lib/kb/queries';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { requestBaseUrl } from '@/lib/kb/site';

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
 *
 * Two callers now, wanting different amounts: the composer's suggestion strip,
 * which interrupts someone mid-sentence and shows a few titles, and the home
 * screen's search box, which is the visitor's own question and replaces the FAQ
 * list with its answer. Five is the larger of the two and the strip takes the
 * first three, rather than a `limit` parameter — the cap is what stops this
 * being a way to page through the knowledge base one request at a time.
 */
const RESULTS = 5;

export async function GET(request: Request) {
  if (!allow(`widget-search:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ articles: [] }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  const requested = params.get('locale') ?? DEFAULT_LOCALE;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  if (query.length < 3) return NextResponse.json({ articles: [] });

  const hits = await searchArticles(ANONYMOUS, locale, query, RESULTS);
  /*
   * The host this request arrived on, which is the one that served the frame —
   * not `publicBaseUrl()`, unlike the link an agent sends (`articleOrigins`).
   * The visitor's chat lives in that host's storage: the article opens in a
   * help-centre page whose launcher frames the same host, so their conversation
   * is still there, where on the other host it would start empty
   * (`docs/embedding-the-widget.md`). And the host the frame came from has just
   * answered from this app, where nothing checks that the published one does
   * (`requestBaseUrl` says when it did not). This is a link for somebody
   * reading right now, not a published address that has to stay put; the
   * sitemap and the canonicals keep the configured host.
   */
  const base = requestBaseUrl(request.headers);

  return NextResponse.json({
    articles: hits.map((hit) => ({
      title: hit.title,
      // Carried so a hit opens in the panel like an FAQ does, rather than
      // throwing the visitor out to a browser tab mid-question.
      slug: hit.slug,
      url: `${base}/${locale}/a/${encodeURI(hit.slug)}`,
    })),
  });
}
