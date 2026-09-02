import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { widgetFaqs } from '@/lib/widget/faq';
import { allowedHostOrigins } from '@/lib/widget/origins';
import { widgetHours } from '@/lib/widget/session';
import { WidgetChat } from './chat';

export const dynamic = 'force-dynamic';

// Never indexed: this is a UI fragment, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

/**
 * The iframe's document.
 *
 * The questions and the schedule are read here rather than fetched once the
 * widget has mounted, and that is the difference between a list that is *there*
 * and one that appears a moment later under the visitor's thumb. The page is
 * already `force-dynamic` and already renders per open, so both cost one query
 * on a request that was happening anyway.
 *
 * It is also what lets the widget open without a session: the home screen needs
 * no token, so a visitor who reads an FAQ and leaves never becomes a `contacts`
 * row. `setLocale()` on the host re-points the iframe's `src`, so a language
 * switch re-runs both reads rather than translating what is already on screen.
 *
 * `widgetFaqs` resolves the viewer itself, and it is `ANONYMOUS` for the reason
 * `/api/widget/search` states: the widget authenticates a browser on somebody
 * else's website, which is not the portal session that says who a customer is,
 * so a `logged_in` article must never reach a screen any page can embed.
 */
export default async function WidgetPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale: requested } = await searchParams;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  // Independent, and both on the panel's critical path.
  const [faqs, hours] = await Promise.all([widgetFaqs(locale), widgetHours()]);

  const online = hours ? isWithinBusinessHours(hours) : false;
  const opensAt = !online && hours ? nextOpeningAt(hours) : null;

  return (
    <WidgetChat
      locale={locale}
      hostOrigins={allowedHostOrigins()}
      faqs={faqs}
      online={online}
      opensAt={opensAt?.toISOString() ?? null}
    />
  );
}
