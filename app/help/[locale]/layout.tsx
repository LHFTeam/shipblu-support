import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShipBluLogo } from '@/components/brand';
import { DEFAULT_LOCALE, direction, isLocale, LOCALES, LOCALE_NAMES, t } from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';
import { viewerIsTeamMember } from '@/lib/widget/audience';
import { AccountNav } from './account-nav';
import { ChatWidget } from './chat';
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
 * The same wrapper carries `kb-shell`, which is where the help centre's palette
 * and typefaces are scoped. Nothing in `globals.css` can reach the console from
 * inside it.
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

  const isTeamMember = await viewerIsTeamMember();

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
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--button-primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        {t(locale, 'skipToContent')}
      </a>

      <header className="kb-noprint sticky top-0 z-30 border-b border-[var(--kb-border)] bg-[var(--kb-surface)]">
        <Container className="flex flex-wrap items-center gap-x-6 gap-y-3 py-3">
          <Link
            href={`/${locale}`}
            className="flex items-center gap-2.5 font-bold text-[var(--kb-heading)]"
          >
            <ShipBluLogo className="size-9" />
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
              className="font-medium text-[var(--kb-heading)] underline-offset-4 hover:underline"
            >
              {t(locale, 'trackTitle')}
            </Link>

            <LocaleSwitcher locale={locale} />

            <AccountNav locale={locale} />

            <Link
              href={`/${locale}/forms`}
              className="rounded-md bg-[var(--button-primary)] px-3.5 py-2 font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
            >
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

      <footer className="kb-noprint bg-[var(--kb-footer)] text-[var(--kb-footer-text)]">
        <Container className="flex flex-wrap items-center gap-x-6 gap-y-3 py-8 text-sm">
          <span className="font-semibold">ShipBlu</span>

          <Link href={`/${locale}`} className="underline-offset-4 opacity-80 hover:opacity-100">
            {t(locale, 'home')}
          </Link>

          <span className="opacity-80">
            {t(locale, 'contactPrompt')}{' '}
            <a
              href="mailto:support@shipblu.com"
              className="underline underline-offset-4 hover:opacity-100"
            >
              support@shipblu.com
            </a>
          </span>

          <span className="sm:ms-auto opacity-60">
            © {new Date().getFullYear()} ShipBlu. {t(locale, 'footerRights')}
          </span>
        </Container>
      </footer>

      {/*
        Renders nothing: the snippet appends its own launcher to the document
        body, as it does on any other host page. In the layout rather than on
        one page because a visitor who cannot find an answer gives up wherever
        they happen to be — most often on a search that returned nothing.

        Not for a signed-in team member. The launcher is a customer's way in,
        and this is a surface the team reads on too — see `viewerIsTeamMember`.
        Left out rather than hidden with CSS: the snippet is then never
        fetched, `chatWidget()` stays null, and the tracking page's "Ask
        support" falls back to the form link it already carries as its `href`,
        which is exactly what that fallback is there for. And taken back down
        when this layout goes, for a reader who signs in here and is sent to the
        console without a reload — see `removeChat`.
      */}
      {isTeamMember ? null : <ChatWidget locale={locale} />}
    </div>
  );
}

/**
 * Two locales, so two links rather than a dropdown: a menu that has to be
 * opened to find out it holds two things is a menu that should have been the
 * two things.
 *
 * Both point at that locale's front page rather than at a translation of the
 * current one. There is no general path mapping — an Arabic article has its own
 * slug — and the article page offers the direct link to its own translation
 * where one exists, which is the only place the mapping is actually known.
 */
function LocaleSwitcher({ locale }: { locale: (typeof LOCALES)[number] }) {
  return (
    <div
      role="group"
      aria-label={t(locale, 'language')}
      className="flex items-center overflow-hidden rounded-md border border-[var(--kb-border)]"
    >
      {LOCALES.map((option) => {
        const current = option === locale;
        return (
          <Link
            key={option}
            href={`/${option}`}
            lang={option}
            hrefLang={option}
            aria-current={current ? 'true' : undefined}
            className={`px-2.5 py-1 text-xs font-medium transition-colors ${
              current
                ? 'bg-[var(--kb-band)] text-[var(--kb-band-text)]'
                : 'text-[var(--kb-muted)] hover:bg-[var(--kb-surface-2)]'
            }`}
          >
            {LOCALE_NAMES[option]}
          </Link>
        );
      })}
    </div>
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
