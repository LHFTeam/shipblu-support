import { NextResponse } from 'next/server';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { getArticle } from '@/lib/kb/queries';
import { allow, clientIp } from '@/lib/http/rate-limit';
import { articleUrl, requestBaseUrl } from '@/lib/kb/site';
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
    // The widget's "read more", the one help-centre link a visitor can click
    // in it, built on the origin this request arrived on, which is the one that
    // served the frame. Not `publicBaseUrl()`, unlike the link an agent sends
    // (`articleOrigins`): this is a link for somebody reading right now, not an
    // address they keep, and the frame's host has just answered from this app,
    // where nothing checks that the published one does (`requestBaseUrl` says
    // when it did not). The help-centre page it opens draws its launcher from
    // that same host, the one whose storage holds the visitor's chat, though a
    // chat a host page identified is kept there and not reopened, since the
    // help centre names nobody (`judge()` in `lib/widget/person.ts`).
    url: articleUrl(requestBaseUrl(request.headers), locale, article.slug),
  });
}
