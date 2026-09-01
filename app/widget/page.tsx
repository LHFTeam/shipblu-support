import { headers } from 'next/headers';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { popularArticles } from '@/lib/kb/queries';
import { requestBaseUrl } from '@/lib/kb/site';
import { ANONYMOUS } from '@/lib/kb/visibility';
import { allowedHostOrigins } from '@/lib/widget/origins';
import { WidgetChat } from './chat';

export const dynamic = 'force-dynamic';

// Never indexed: this is a UI fragment, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

/**
 * How many questions the opening screen offers.
 *
 * Five, because the panel is 380x600 and the list shares that screen with the
 * composer: a longer list pushes the thing the visitor came to do off the
 * bottom, and a list nobody scrolls to the end of is a list whose last entries
 * are decoration.
 */
const FAQ_COUNT = 5;

export default async function WidgetPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale: requested } = await searchParams;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  /*
   * The questions are read here rather than fetched by the widget once it has
   * mounted, and that is the difference between a list that is *there* and one
   * that appears a moment later under the visitor's thumb. The page is already
   * `force-dynamic` and already renders per open, so it costs one query on a
   * request that was happening anyway — and it needs no public endpoint of its
   * own to rate limit.
   *
   * `ANONYMOUS` for the same reason `/api/widget/search` uses it: the widget
   * authenticates a browser on somebody else's website, which is not the portal
   * session that says who a customer is. A `logged_in` article must not reach
   * the opening screen of a widget any page can embed.
   */
  const [articles, headerList] = await Promise.all([
    popularArticles(ANONYMOUS, locale, FAQ_COUNT),
    headers(),
  ]);

  /*
   * Links built from the host this frame was served on, not from
   * `publicBaseUrl()`. The widget frames whichever of our hostnames served the
   * snippet, so the request's own Host is the one that will answer — while
   * `KB_PUBLIC_HOST` currently names `support.shipblu.com`, which has never
   * pointed at this app and answers 404 (`docs/PROJECT-STATE.md` §4). A list of
   * dead links is worse than no list.
   */
  const base = requestBaseUrl(headerList);

  return (
    <WidgetChat
      locale={locale}
      hostOrigins={allowedHostOrigins()}
      faqs={articles.map((article) => ({
        title: article.title,
        url: `${base}/${locale}/a/${encodeURI(article.slug)}`,
      }))}
    />
  );
}
