import Link from 'next/link';
import type { ReactNode } from 'react';
import { BookIcon, ChevronRightIcon } from '@/components/icons';
import { buttonClass } from '@/components/ui';
import { formatOpening } from '@/lib/hours';
import { jsonForScript } from '@/lib/html/json-script';
import { accentSplit } from '@/lib/kb/accent';
import type { SupportAvailability } from '@/lib/kb/availability';
import { t, type Locale } from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';
import { SupportArt } from './art';
import { SearchBox } from './search-box';
import { AskSupport } from './track/support';

/**
 * The shapes every help-centre page is built from.
 *
 * Kept in one file, and deliberately small: a help centre is four page types
 * (index, category, folder, article) wearing the same clothes, and the moment
 * each page declares its own container width and its own card padding they
 * start drifting. A customer who has read one page should already know how to
 * read the next.
 *
 * The clothes are the help-centre design's ("ShipBlu support landing page v02"
 * in Claude Design): a pale brand band carrying the trail and the title, white
 * cards on the grey canvas, and a pale "still need help?" band at the foot of
 * every topic and article.
 */

/**
 * The one column width, the design's 1120px.
 *
 * Full-bleed bands take the container inside them rather than breaking out of
 * it, so nothing needs negative margins to reach the edge of the viewport.
 */
export function Container({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`mx-auto w-full max-w-[70rem] px-4 sm:px-8 ${className}`}>{children}</div>;
}

/** The page body: one container, one vertical rhythm, on every page. */
export function PageBody({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <Container className={`pt-8 pb-12 sm:pt-9 sm:pb-16 ${className}`}>{children}</Container>;
}

export type Crumb = { label: string; href: string };

/**
 * The trail of ancestors, current page excluded.
 *
 * Excluded because the current page is already the `<h1>` immediately below,
 * and a breadcrumb that ends in the title of the page you are looking at is
 * repeating itself. The design draws it there; this is the one place the page
 * keeps to its own earlier decision instead. The current page *is* in the
 * structured data, where the last entry is what tells a search engine which
 * page the trail describes.
 */
export function Breadcrumbs({ locale, items }: { locale: Locale; items: Crumb[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label={t(locale, 'breadcrumb')} className="kb-noprint">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {items.map((item, index) => (
          <li key={item.href} className="flex items-center gap-x-1.5">
            {index > 0 ? (
              <ChevronRightIcon size={14} className="shrink-0 text-(--color-text-tertiary)" />
            ) : null}
            <Link
              href={item.href}
              className="text-(--color-text-secondary) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * `BreadcrumbList` for the trail, current page included.
 *
 * Absolute URLs from `publicBaseUrl()`, because the pages are served from a
 * rewritten path and a relative `item` would describe a URL that does not
 * exist. Emitted next to the visible trail rather than assembled separately in
 * each page's metadata, so the two can never disagree about the hierarchy.
 *
 * Through `jsonForScript`, never a bare `JSON.stringify`: the search page's
 * crumb is the reader's own query, and a `</script>` in it would otherwise end
 * the element and run whatever followed.
 */
function BreadcrumbSchema({ items }: { items: Crumb[] }) {
  const base = publicBaseUrl();
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.label,
      item: `${base}${item.href}`,
    })),
  };

  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonForScript(data) }} />
  );
}

/**
 * A title with one word in the brand blue — "How can we **help?**",
 * "Shipments & **tracking**", "**شركاء** شيب بلو" — the design's one flourish on
 * a title. Which word is `accentSplit`'s question (`lib/kb/accent.ts`): the last
 * in English, the head of the phrase in Arabic. The space is kept outside the
 * span so the browser's line breaking is untouched.
 */
export function AccentTitle({ text, at }: { text: string; at: 'first' | 'last' }) {
  const split = accentSplit(text, at);
  if (!split) return <>{text.trim()}</>;

  const word = <span className="text-(--color-text-brand)">{split.word}</span>;
  return split.accent === 'first' ? (
    <>
      {word} {split.rest}
    </>
  ) : (
    <>
      {split.rest} {word}
    </>
  );
}

/**
 * The header of every page below the front door: one pale band carrying the
 * trail, the title, what the page is for and the facts about it.
 *
 * The band is the brand's palest tint with a hairline under it, and nothing
 * else. It used to be a full-bleed blue slab, and blue is the action colour — a
 * title painted in it is the loudest thing on the page and says nothing. Since
 * the redesign the trail sits on the band too, rather than on a white strip of
 * its own above it, so the band is the whole header and reads as one object.
 *
 * Search sits at the trail's end by default rather than living only on the
 * home page, because a customer who has opened the wrong article should not
 * have to go back to the front door to try a different phrase. A page whose
 * body is a search of its own — a topic's "Search in …" — turns it off and
 * passes its own field as `children`, under the title.
 *
 * `art` is drawn at the band's end from `sm` up and left out on a phone, where
 * it would push the title a screen down for a picture.
 */
export function PageHeader({
  locale,
  crumbs,
  title,
  selfPath,
  accent = false,
  lede,
  meta,
  art,
  search = true,
  searchInitial,
  children,
}: {
  locale: Locale;
  /** Ancestors, nearest last. The current page is added for structured data. */
  crumbs: Crumb[];
  title: string;
  /** The current page's own path, for the structured-data trail. */
  selfPath: string;
  /** The topic's word in the brand blue, as the design draws topic titles. */
  accent?: boolean;
  /** One sentence under the title: what this page is for. A page's intro goes here. */
  lede?: ReactNode;
  /**
   * Small facts about the page — a count, a date, a translation link — set at
   * 12px. Not a sentence: a page's intro in this slot reads as fine print.
   */
  meta?: ReactNode;
  art?: ReactNode;
  search?: boolean;
  /** Pre-fills the field. The results page seeds it so a near miss can be edited
      rather than retyped. */
  searchInitial?: string;
  /** Under the meta line: a page's own search field, or a call to action. */
  children?: ReactNode;
}) {
  return (
    <>
      <BreadcrumbSchema items={[...crumbs, { label: title, href: selfPath }]} />

      <div className="border-b border-(--color-border-subtle) bg-(--color-background-brand-subtle) text-(--color-text-primary)">
        <Container className="pt-6 pb-8 sm:pb-9">
          {crumbs.length > 0 || search ? (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Breadcrumbs locale={locale} items={crumbs} />
              {search ? (
                <div className="kb-noprint w-full sm:ms-auto sm:w-72">
                  <SearchBox locale={locale} initial={searchInitial} />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-8">
            <div className="min-w-0 max-w-[42rem] flex-1">
              <h1
                className={`text-read-h1 font-bold text-balance break-words sm:text-read-h1-md ${
                  locale === 'ar' ? 'leading-read-heading-ar' : 'tracking-tight'
                }`}
              >
                {accent ? (
                  <AccentTitle text={title} at={locale === 'ar' ? 'first' : 'last'} />
                ) : (
                  title
                )}
              </h1>
              {lede ? (
                <p className="mt-2.5 max-w-[62ch] text-read-ui text-(--color-text-secondary)">
                  {lede}
                </p>
              ) : null}
              {meta ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-(--color-text-secondary)">
                  {meta}
                </div>
              ) : null}
              {children ? <div className="mt-5">{children}</div> : null}
            </div>

            {art ? <div className="kb-noprint hidden shrink-0 sm:block">{art}</div> : null}
          </div>
        </Container>
      </div>
    </>
  );
}

/** The one card shape: see `.kb-panel` in `globals.css`. */
export function Panel({
  as: Tag = 'div',
  className = '',
  children,
}: {
  as?: 'div' | 'section' | 'aside';
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={`kb-panel ${className}`}>{children}</Tag>;
}

/**
 * One article in a list: the book, the title in link blue, its excerpt, and a
 * chevron saying the row goes somewhere.
 *
 * The book is not decoration: in a list that mixes folders and articles it is
 * the one thing that says a link opens an answer rather than another list. The
 * whole row is the link, so a thumb that lands on the excerpt still arrives.
 */
export function ArticleRow({
  href,
  title,
  excerpt,
  meta,
  level: Heading = 'h2',
}: {
  href: string;
  title: string;
  excerpt?: string | null;
  /** A short label at the row's end — a category on a search result. */
  meta?: ReactNode;
  level?: 'h2' | 'h3';
}) {
  return (
    <li className="border-b border-(--color-border-subtle) last:border-0">
      {/*
        The focus ring is drawn inside the row. The list card clips its overflow
        to keep the rounded corners, so the global ring, offset outwards, was
        cut away on three sides and left a keyboard reader with a 2px line or
        nothing. The `!` is needed against that unlayered global rule (§6.93).
      */}
      <Link
        href={href}
        className="group flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-(--color-background-hover) focus-visible:bg-(--color-background-hover) focus-visible:outline-offset-[-2px]!"
      >
        <BookIcon
          size={18}
          className="shrink-0 self-start text-(--color-text-tertiary) sm:self-center"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Heading className="text-[0.9375rem] leading-snug font-bold text-(--color-text-link) group-hover:text-(--color-text-link-hover)">
            {title}
          </Heading>
          {excerpt ? (
            <span className="line-clamp-2 text-sm text-(--color-text-secondary)">{excerpt}</span>
          ) : null}
          {/* Below sm the end column has no room, and the label still has to
              show: on a search it is what says a result belongs to the other
              audience. Only one copy is ever displayed. */}
          {meta ? (
            <span className="text-xs text-(--color-text-secondary) sm:hidden">{meta}</span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-xs whitespace-nowrap text-(--color-text-secondary) max-sm:hidden">
            {meta}
          </span>
        ) : null}
        <ChevronRightIcon size={16} className="shrink-0 text-(--color-text-tertiary)" />
      </Link>
    </li>
  );
}

/** A list of articles inside a card. */
export function ArticleList({ children }: { children: ReactNode }) {
  return (
    <Panel as="section" className="overflow-hidden">
      <ul>{children}</ul>
    </Panel>
  );
}

/**
 * The label above a grid or a list, one step under the page's `h1`.
 *
 * `meta` sits on the same baseline rather than under the heading — a count or a
 * date is an attribute of the section, and putting it on its own line makes the
 * reader parse it as the section's first item.
 */
export function SectionHeading({
  children,
  meta,
  id,
}: {
  children: ReactNode;
  meta?: ReactNode;
  /** For a section the header's links point at (`#topics`, `#contact`). */
  id?: string;
}) {
  if (!meta) {
    return (
      <h2 id={id} className="mb-4 scroll-mt-24 text-xl font-bold text-(--color-text-primary)">
        {children}
      </h2>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={id} className="scroll-mt-24 text-xl font-bold text-(--color-text-primary)">
        {children}
      </h2>
      <span className="text-sm text-(--color-text-secondary)">{meta}</span>
    </div>
  );
}

/** Nothing here yet — said once, in a card, so the page still looks finished. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <Panel className="p-8 text-center text-sm text-(--color-text-secondary)">
      <p>{children}</p>
    </Panel>
  );
}

/**
 * "Support is answering now", or when it will be.
 *
 * Rendered from the same schedule the chat widget is gated on, and rendered not
 * at all when no schedule is configured — see `lib/kb/availability.ts`. A help
 * centre that has not been told its own opening hours must not guess at them in
 * front of somebody deciding whether to wait, which is why the design's printed
 * "Sunday to Thursday, 09:00–18:00" is this line instead.
 */
export function Availability({
  locale,
  availability,
  className = '',
}: {
  locale: Locale;
  availability: SupportAvailability | null;
  className?: string;
}) {
  if (!availability) return null;

  if (availability.open) {
    return (
      <p
        className={`flex items-center gap-2 text-sm font-bold text-(--color-feedback-success-fg) ${className}`}
      >
        <span aria-hidden className="size-2 rounded-full bg-current" />
        {t(locale, 'supportOpen')}
      </p>
    );
  }

  const opening = availability.opensAt
    ? t(locale, 'supportOpensAt').replace(
        '{when}',
        formatOpening(availability.opensAt, availability.timezone, locale),
      )
    : t(locale, 'supportClosed');

  return <p className={`text-sm text-(--color-text-secondary) ${className}`}>{opening}</p>;
}

/**
 * The pale band at the foot of a topic or an article: "Didn't find your
 * answer?", "Stuck on a step?" — the headset, one sentence, and the button.
 *
 * The button opens the chat rather than the front page's list of channels, as
 * the design has it: somebody who has read to the bottom of an article that did
 * not help has already chosen to ask. Not the contact forms either, though that
 * is the link underneath: with no ticket form built — production has none —
 * `/forms` redirects to `/portal/new`, which asks for an account, and most
 * people reading the help centre do not have one. The chat needs none.
 * `AskSupport` keeps `/forms` as the `href` for a page whose chat never loaded.
 */
export function HelpCta({
  locale,
  title,
  availability = null,
  className = '',
}: {
  locale: Locale;
  title: string;
  availability?: SupportAvailability | null;
  className?: string;
}) {
  return (
    <section
      className={`kb-noprint flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border border-(--color-border-subtle) bg-(--color-background-brand-subtle) px-6 py-5 ${className}`}
    >
      <SupportArt className="kb-art-fade-wide w-40 shrink-0" />
      <div className="min-w-0 flex-[1_1_16rem]">
        <h2 className="text-lg font-bold text-(--color-text-primary)">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-(--color-text-secondary)">
          {t(locale, 'contactIntro')}
        </p>
        <Availability locale={locale} availability={availability} className="mt-2" />
      </div>
      <AskSupport href={`/${locale}/forms`} className={buttonClass()}>
        {t(locale, 'contactAction')}
      </AskSupport>
    </section>
  );
}
