import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ShipBluMark } from '@/components/brand';
import {
  DEFAULT_LOCALE,
  direction,
  isLocale,
  LOCALES,
  LOCALE_NAMES,
  LOCALE_SHORT,
  t,
  type Locale,
} from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';
import { AccountNav } from './account-nav';
import { AskSupport } from './track/support';
import { Container } from './chrome';
import { ServiceNoticeBanner } from './notice';
import { geist } from './fonts';

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
      className={`kb-shell ${geist.variable} flex min-h-dvh flex-col antialiased`}
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
        <Container className="flex min-h-14 flex-wrap items-center gap-x-6 gap-y-2 py-2.5">
          <Link
            href={`/${locale}`}
            className="flex items-center gap-2.5 font-semibold text-(--color-text-primary)"
          >
            {/* The bare mark, as the design draws it on this white header. The
                console's tile (`ShipBluLogo`) is for its navy rail, where the
                mark needs the white behind it; here it would only add a box. */}
            <ShipBluMark className="w-[18px] shrink-0" />
            <span className={`text-[15px] ${locale === 'ar' ? '' : 'tracking-tight'}`}>
              {t(locale, 'title')}
            </span>
          </Link>

          <nav
            aria-label={t(locale, 'mainNavLabel')}
            className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm sm:ms-auto"
          >
            {/*
              The design's four destinations, plus tracking. "Knowledge base"
              and "Contact" are the front page's own sections (`#topics`,
              `#contact`) rather than a second link to the page the logo already
              opens, and they step aside on a phone, where the header would
              otherwise take three lines of a small screen.

              Tracking is not in the design's header and stays in this one: the
              visitor who wants it most is the one who arrived on an article from
              a search engine and still does not know where their parcel is, and
              the front page's tracking card is a page away from them. The design
              also offers a "Merchant portal" link; nothing in this system knows
              the dashboard's address, and a dead link in the header is worse than
              none.
            */}
            <Link href={`/${locale}#topics`} className={`${NAV_LINK} max-sm:hidden`}>
              {t(locale, 'navKnowledgeBase')}
            </Link>
            <Link href={`/${locale}/track`} className={NAV_LINK}>
              {t(locale, 'trackTitle')}
            </Link>
            <Link href={`/${locale}#contact`} className={`${NAV_LINK} max-sm:hidden`}>
              {t(locale, 'navContact')}
            </Link>

            <LocaleSwitcher locale={locale} />

            <AccountNav locale={locale} />
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

      <footer className="kb-noprint border-t border-(--color-border-subtle) bg-(--color-background-surface)">
        {/* Extra room under the footer on a phone: the help centre's own chat
            launcher sits fixed over the bottom 76px and covered the support
            email link.

            Light, as the design draws it, where it used to be the navy inverse
            surface: the page ends on the same white its header starts on, and the
            pale "still need help?" band above it is the last thing that asks for
            attention. The design's Service status, Coverage, Terms and Privacy
            links are not here because none of those pages has an address this
            system knows; every link that is here goes somewhere that answers. */}
        <Container className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-6 pb-24 text-xs text-(--color-text-secondary) sm:pb-6">
          <span lang="en" className="font-medium text-(--color-text-secondary)">
            ShipBlu
          </span>

          <Link href={`/${locale}`} className={FOOTER_LINK}>
            {t(locale, 'home')}
          </Link>
          <Link href={`/${locale}/track`} className={FOOTER_LINK}>
            {t(locale, 'trackTitle')}
          </Link>
          {/* The chat, like every other Contact support: on a phone this is the
              one contact control left on the page, and `/forms` asks for an
              account while no ticket form is built (`AskSupport`). */}
          <AskSupport href={`/${locale}/forms`} className={FOOTER_LINK}>
            {t(locale, 'contactAction')}
          </AskSupport>
          <a href="mailto:support@shipblu.com" dir="ltr" className={FOOTER_LINK}>
            support@shipblu.com
          </a>

          <span className="text-(--color-text-tertiary) sm:ms-auto">
            © {new Date().getFullYear()} <bdi lang="en">ShipBlu</bdi>. {t(locale, 'footerRights')}
          </span>
        </Container>
      </footer>
    </div>
  );
}

/* Regular weight, as the design draws them: bold, three text links outweighed
   the Sign in button beside them and the help centre's name. */
const NAV_LINK =
  'text-(--color-text-secondary) underline-offset-4 hover:text-(--color-text-primary) hover:underline';
const FOOTER_LINK = 'underline-offset-4 hover:text-(--color-text-primary) hover:underline';

/**
 * The language switch, drawn as the design draws it: both languages side by
 * side, the one you are reading marked as selected.
 *
 * Only the other one is a link. The current one is a label in the selected
 * tint, not a control — it used to be a link to the page already open, painted
 * in the action blue that everywhere else means "press this", and that is what
 * made it confusing, not the second name beside it. Each is labelled in its own
 * script, because the reader who needs it is the one who cannot read the page's,
 * and the pair is always English-then-Arabic, left to right, so it does not swap
 * sides when the page does.
 *
 * Two things the design's 26px segments do not do. On a phone each is 40px tall,
 * a target a thumb can find beside the 42px Sign in. And the link's focus ring
 * is drawn inside it: the group clips its overflow for the rounded corners, and
 * the global ring, offset outwards, was cut away — on an Arabic page, where the
 * link is the first segment, entirely.
 *
 * It points at that locale's front page rather than at a translation of the
 * current one. There is no general path mapping — an Arabic article has its own
 * slug — and the article page offers the direct link to its own translation
 * where one exists, which is the only place the mapping is actually known.
 */
function LocaleSwitcher({ locale }: { locale: Locale }) {
  return (
    <div
      role="group"
      aria-label={t(locale, 'languageLabel')}
      dir="ltr"
      className="flex items-center overflow-hidden rounded-md border border-(--color-border-subtle) text-xs font-medium"
    >
      {LOCALES.map((option) =>
        option === locale ? (
          <span
            key={option}
            lang={option}
            aria-current="true"
            className="bg-(--color-background-selected) px-2.5 py-1.5 text-(--color-text-brand) max-sm:py-3"
          >
            {LOCALE_SHORT[option]}
          </span>
        ) : (
          <Link
            key={option}
            href={`/${option}`}
            lang={option}
            hrefLang={option}
            aria-label={LOCALE_NAMES[option]}
            className="px-2.5 py-1.5 text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) hover:text-(--color-text-primary) focus-visible:outline-offset-[-2px] max-sm:py-3"
          >
            {LOCALE_SHORT[option]}
          </Link>
        ),
      )}
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
