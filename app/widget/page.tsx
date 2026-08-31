import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { widgetFaqs } from '@/lib/widget/faq';
import { widgetHours } from '@/lib/widget/session';
import { WidgetChat } from './chat';

export const dynamic = 'force-dynamic';

// Never indexed: this is a UI fragment, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

/**
 * The iframe's document.
 *
 * It reads the FAQ list and the schedule here rather than leaving the client to
 * fetch them, for two reasons. The panel is created on the first launcher click,
 * so its load is something a visitor is watching — server-rendering means it
 * appears with answers already in it instead of a spinner. And it is what lets
 * the widget open without a session: the home screen needs no token, so a
 * visitor who reads an FAQ and leaves never becomes a `contacts` row.
 *
 * `setLocale()` on the host re-points the iframe's `src`, so a language switch
 * re-runs both reads rather than translating what is already on screen.
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
      faqs={faqs.map(({ title, slug }) => ({ title, slug }))}
      online={online}
      opensAt={opensAt?.toISOString() ?? null}
    />
  );
}
