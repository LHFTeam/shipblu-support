import { DEFAULT_LOCALE, isLocale } from '@/lib/kb/locale';
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

  return <WidgetChat locale={locale} />;
}
