import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
import { allowedHostOrigins } from '@/lib/widget/origins';
import { WidgetChat } from './chat';

export const dynamic = 'force-dynamic';

// Never indexed: this is a UI fragment, not a page anyone should land on.
export const metadata = { robots: { index: false, follow: false } };

export default async function WidgetPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string }>;
}) {
  const { locale: requested } = await searchParams;
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;

  /*
   * Read here rather than in the client bundle: the list is configuration, and
   * a page that is already `force-dynamic` can hand it over per request instead
   * of baking a build-time value into a script every host page loads.
   */
  return <WidgetChat locale={locale} hostOrigins={allowedHostOrigins()} />;
}
