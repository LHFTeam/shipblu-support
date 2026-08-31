import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { getArticle } from '@/lib/kb/queries';
import { allow, clientIp } from '@/lib/kb/rate-limit';
import { requestBaseUrl } from '@/lib/kb/site';
import { ANONYMOUS } from '@/lib/kb/visibility';

export const dynamic = 'force-dynamic';

/**
 * One article, to be read inside the widget.
 *
 * Reading the answer in the panel is the whole point of putting FAQs in front of
 * the composer: a link that opens the help centre in a new tab is a visitor who
 * has left the widget, and the "still need help" button is the one thing we want
 * them to still be able to reach.
 *
 * `ANONYMOUS`, always, for the reason `/api/widget/search` states beside it: the
 * widget authenticates a visitor's browser, not a customer's session, so a
 * `logged_in` article must not be reachable through it. `getArticle` applies the
 * folder's visibility as well as the article's, which is what keeps the
 * agents-only handbook out of a panel embedded on someone else's website.
 *
 * The body is returned as stored. It was sanitised on write — by the console
 * action and by the Freshdesk importer, both through `lib/html/sanitize.ts` —
 * and sanitising again on the way out is the pattern that eventually lets an
 * unsanitised write through because "the reader cleans it".
 */
export async function GET(request: Request) {
  if (!allow(`widget-article:${clientIp(request)}`, 60, 60_000)) {
    return NextResponse.json({ error: 'slow down' }, { status: 429 });
  }

  const params = new URL(request.url).searchParams;
  const slug = (params.get('slug') ?? '').trim();
  const requested = params.get('locale') ?? DEFAULT_LOCALE;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  if (!slug) return NextResponse.json({ error: 'no slug' }, { status: 400 });

  const article = await getArticle(ANONYMOUS, locale, slug);
  if (!article) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    // Returned so the panel can beacon a read to /api/kb/view, the same public
    // endpoint the help centre's article page uses.
    id: article.id,
    title: article.title,
    bodyHtml: article.bodyHtml,
    // The origin this request actually arrived on, not the one we publish.
    // `publicBaseUrl()` names KB_PUBLIC_HOST, which does not serve this app yet
    // — a canonically correct link that 404s for the person who clicked it.
    url: `${requestBaseUrl(request.headers)}/${locale}/a/${encodeURI(article.slug)}`,
  });
}
