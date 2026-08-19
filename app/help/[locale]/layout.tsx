import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DEFAULT_LOCALE, direction, isLocale, LOCALES, LOCALE_NAMES, t } from '@/lib/kb/locale';
import { AccountNav } from './account-nav';
import { SearchBox } from './search-box';

export const dynamic = 'force-dynamic';

/**
 * Public help centre shell.
 *
 * `dir` is set on a wrapper rather than on `<html>` because the root layout is
 * shared with the agent console, which is always LTR. A wrapper is enough:
 * `dir` is inherited, and every layout decision below it is logical
 * (`ms-`/`me-`, `start`/`end`) rather than physical, so Arabic mirrors without
 * a second stylesheet.
 */
export default async function KbLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <div dir={direction(locale)} lang={locale} className="flex min-h-dvh flex-col">
      <header className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-4">
          <Link href={`/${locale}`} className="text-base font-semibold">
            {t(locale, 'title')}
          </Link>

          <div className="order-3 w-full sm:order-none sm:ms-auto sm:w-80">
            <SearchBox locale={locale} />
          </div>

          <nav className="flex items-center gap-2 text-sm sm:ms-2">
            {LOCALES.map((option) => (
              <Link
                key={option}
                href={`/${option}`}
                lang={option}
                className={
                  option === locale
                    ? 'font-medium underline underline-offset-4'
                    : 'opacity-60 hover:opacity-100'
                }
              >
                {LOCALE_NAMES[option]}
              </Link>
            ))}
          </nav>

          <AccountNav locale={locale} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>

      <footer className="border-t border-[var(--border)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-6 text-sm opacity-60">
          <span>ShipBlu</span>
          <Link href={`/${locale}`} className="hover:opacity-100">
            {t(locale, 'home')}
          </Link>
          <span className="ms-auto">
            {t(locale, 'contactPrompt')}{' '}
            <a href="mailto:support@shipblu.com" className="underline underline-offset-4">
              {t(locale, 'contactAction')}
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export const metadata = {
  title: 'ShipBlu Support',
};

export { DEFAULT_LOCALE };
