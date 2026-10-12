import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShipBluLogo } from '@/components/brand';
import { buttonClass } from '@/components/ui';
import { DEFAULT_LOCALE, direction, isLocale, LOCALES, LOCALE_NAMES, t } from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';
import { AccountNav } from './account-nav';
import { Container } from './chrome';
import { ServiceNoticeBanner } from './notice';
import { lato, tajawal } from './fonts';

export const dynamic = 'force-dynamic';

/**
 * Public help centre shell.
 *
 * `dir` is set on a wrapper rather than on `<html>` because the root layout is
 * shared with the agent console, which is always LTR. A wrapper is enough:
 * `dir` is inherited, and every layout decision below it is logical
 * (`ms-`/`me-`, `start`/`end`) rather than physical, so Arabic mirrors without
 * a second stylesheet.
 *
 * The same wrapper carries `kb-shell`, which is where the help centre's
 * typefaces and reading density are scoped. The colours are the design
 * system's roles, the same ones the console reads, so the two cannot drift
 * apart; what differs is how much room a page gives the words.
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
    <div
      dir={direction(locale)}
      lang={locale}
      className={`kb-shell ${lato.variable} ${tajawal.variable} flex min-h-dvh flex-col antialiased`}
    >
      {/*
        First thing in the tab order, invisible until it has focus. On the
        article page the header, the trail and the search field are about a dozen
        stops before the prose a keyboard or screen-reader user came for.
      */}
      <a
        href="#kb-main"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-(--button-primary) focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-(--color-text-on-action)"
      >
        {t(locale, 'skipToContent')}
      </a>

      <header className="kb-noprint sticky top-0 z-30 border-b border-(--color-border-subtle) bg-(--color-background-surface)">
        <Container className="flex min-h-15 flex-wrap items-center gap-x-6 gap-y-3 py-3">
          <Link
            href={`/${locale}`}
            className="flex items-center gap-2.5 font-bold text-(--color-text-primary)"
          >
            <ShipBluLogo className="size-8" />
            <span className="text-base">{t(locale, 'title')}</span>
          </Link>

          <nav
            aria-label={t(locale, 'mainNavLabel')}
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm sm:ms-auto"
          >
            {/*
              Tracking sits in the header rather than only on the front page,
              because the visitor who wants it most is the one who arrived on an
              article from a search engine and still does not know where their
              parcel is.

              It is the only plain link here, and deliberately so: a
              "Knowledge base" link used to sit beside it, pointing at the same
              front page the logo immediately to its left already goes to. Two
              controls a thumb-width apart with one destination is not a second
              way in — it reads as a nav whose page is missing.
            */}
            <Link
              href={`/${locale}/track`}
              className="font-bold text-(--color-text-secondary) underline-offset-4 hover:text-(--color-text-primary) hover:underline"
            >
              {t(locale, 'trackTitle')}
            </Link>

            <LocaleSwitcher locale={locale} />

            <AccountNav locale={locale} />

            <Link href={`/${locale}/forms`} className={buttonClass()}>
              {t(locale, 'contactAction')}
            </Link>
          </nav>
        </Container>
      </header>

      {/*
        Above the content and below the header, so it is read before whatever
        the visitor came for and does not move when they scroll. Renders nothing
        unless a notice has been written.
      */}
      <ServiceNoticeBanner locale={locale} />

      {/*
        `tabIndex` so the skip link can move focus here, not merely scroll to it —
        without it the next Tab goes back to the header the reader just skipped.
      */}
      <main id="kb-main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>

      <footer className="kb-noprint bg-(--color-background-inverse) text-(--color-text-inverse)">
        {/* Extra room under the footer on a phone: the help centre's own chat
            launcher sits fixed over the bottom 76px and covered the support
            email link. */}
        <Container className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-8 pb-24 text-sm sm:pb-8">
          <span className="flex items-center gap-2.5 font-bold">
            <ShipBluLogo className="size-7" />
            ShipBlu
          </span>

          <Link href={`/${locale}`} className="underline-offset-4 hover:underline">
            {t(locale, 'home')}
          </Link>

          <span>
            {t(locale, 'contactPrompt')}{' '}
            <a href="mailto:support@shipblu.com" className="underline underline-offset-4">
              support@shipblu.com
            </a>
          </span>

          <span className="sm:ms-auto">
            © {new Date().getFullYear()} ShipBlu. {t(locale, 'footerRights')}
          </span>
        </Container>
      </footer>
    </div>
  );
}

/**
 * Two locales, so the switch is one link: to the language you are not reading.
 *
 * It used to be both, with the current one filled in the action blue — a link
 * to the page you are already on, painted in the colour that everywhere else
 * means "press this". With two languages the only thing the control can do is
 * take you to the other one, so that is all it offers. Labelled in its own
 * language, because the reader who needs it is the one who cannot read the
 * page's.
 *
 * It points at that locale's front page rather than at a translation of the
 * current one. There is no general path mapping — an Arabic article has its own
 * slug — and the article page offers the direct link to its own translation
 * where one exists, which is the only place the mapping is actually known.
 */
function LocaleSwitcher({ locale }: { locale: (typeof LOCALES)[number] }) {
  const other = LOCALES.find((option) => option !== locale) ?? DEFAULT_LOCALE;

  return (
    <Link
      href={`/${other}`}
      lang={other}
      hrefLang={other}
      className="rounded-full border border-(--color-border-default) px-3 py-1 text-(--color-text-primary) transition-colors hover:bg-(--color-background-hover)"
    >
      {LOCALE_NAMES[other]}
    </Link>
  );
}

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  title: 'ShipBlu Support',
  /*
   * Every `alternates` and `openGraph` URL a page below sets is relative, and
   * Next resolves those against this. Without it they resolve against the
   * Render service hostname, which is the one hostname that must never appear
   * in a canonical tag.
   */
  metadataBase: new URL(publicBaseUrl()),
};

export { DEFAULT_LOCALE };
