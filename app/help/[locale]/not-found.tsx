import Link from 'next/link';
import { DEFAULT_LOCALE, t } from '@/lib/kb/locale';

/**
 * Scoped to the help centre so a missing article does not show a customer the
 * agent console's error page.
 *
 * The locale is not available here — Next renders not-found without route
 * params — so this falls back to English and links home, where the language
 * switcher takes over.
 */
export default function KbNotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">{t(DEFAULT_LOCALE, 'notFound')}</h1>
      <p className="mt-2 opacity-60">{t(DEFAULT_LOCALE, 'notFoundHint')}</p>
      <Link
        href={`/${DEFAULT_LOCALE}`}
        className="mt-6 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        {t(DEFAULT_LOCALE, 'backToHelp')}
      </Link>
    </div>
  );
}
