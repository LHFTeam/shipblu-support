import Link from 'next/link';
import type { ReactNode } from 'react';
import { DocumentIcon } from '@/components/icons';
import { t, type Locale } from '@/lib/kb/locale';
import { publicBaseUrl } from '@/lib/kb/site';
import { SearchBox } from './search-box';

/**
 * The shapes every help-centre page is built from.
 *
 * Kept in one file, and deliberately small: a help centre is four page types
 * (index, category, folder, article) wearing the same clothes, and the moment
 * each page declares its own container width and its own card padding they
 * start drifting. A customer who has read one page should already know how to
 * read the next.
 */

/**
 * The one column width, matching the live portal's 1140px content column.
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
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

/** The page body: one container, one vertical rhythm, on every page. */
export function PageBody({
  className = '',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <Container className={`py-8 sm:py-10 ${className}`}>{children}</Container>;
}

export type Crumb = { label: string; href: string };

/**
 * The trail of ancestors, current page excluded.
 *
 * Excluded because the current page is already the `<h1>` immediately below,
 * and a breadcrumb that ends in the title of the page you are looking at is
 * repeating itself. The current page *is* in the structured data, where the
 * last entry is what tells a search engine which page the trail describes.
 */
export function Breadcrumbs({ locale, items }: { locale: Locale; items: Crumb[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label={t(locale, 'breadcrumb')}>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {items.map((item, index) => (
          <li key={item.href} className="flex items-center gap-x-2">
            {index > 0 ? (
              <span aria-hidden className="text-[var(--kb-border-strong)]">
                /
              </span>
            ) : null}
            <Link
              href={item.href}
              className="text-[var(--kb-muted)] underline-offset-4 hover:text-[var(--kb-link)] hover:underline"
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
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}

/**
 * The band behind the title of every page below the front door.
 *
 * `container-fluid` in Freshdesk's markup, and the same idea here: the colour
 * runs the full width of the viewport while the text inside stays on the
 * content column.
 *
 * Two tones, and the split is a migration rather than a choice a page gets to
 * make on taste. `solid` is the saturated blue this site has always worn.
 * `subtle` is the design system's answer, and the system is explicit that blue
 * is the action colour and never a page background outside an auth or marketing
 * panel — a full-bleed blu-500 slab with a title on it is the loudest thing on
 * the page and says nothing.
 *
 * The redesign that brought the system's palette in covered the front page and
 * the tracking page, so those two are on `subtle`; the front page does not use
 * this at all, having its own hero. Everything else still wears the band, and
 * moving it is a change to those pages' layout rather than to their colours —
 * which is the work this is waiting for, not an argument against it.
 */
type BandTone = 'solid' | 'subtle';

const BAND_TONE: Record<BandTone, string> = {
  solid: 'bg-[var(--kb-band)] text-[var(--kb-band-text)]',
  subtle: 'bg-[var(--kb-band-soft)] text-[var(--kb-heading)] border-b border-[var(--kb-border)]',
};

function Band({
  tone = 'solid',
  className = '',
  children,
}: {
  tone?: BandTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${BAND_TONE[tone]} ${className}`}>
      <Container>{children}</Container>
    </div>
  );
}

/**
 * The header of every page below the front door: the trail and a search field
 * on the page's own surface, then the title on the band.
 *
 * Search is repeated here rather than living only on the home page because a
 * customer who has opened the wrong article should not have to go back to the
 * front door to try a different phrase.
 */
export function PageHeader({
  locale,
  crumbs,
  title,
  selfPath,
  icon,
  meta,
  search = true,
  searchInitial,
  tone = 'solid',
}: {
  locale: Locale;
  /** Ancestors, nearest last. The current page is added for structured data. */
  crumbs: Crumb[];
  title: string;
  /** The current page's own path, for the structured-data trail. */
  selfPath: string;
  icon?: ReactNode;
  meta?: ReactNode;
  search?: boolean;
  /** Pre-fills the field. The results page seeds it so a near miss can be edited
      rather than retyped. */
  searchInitial?: string;
  /** See `Band`: `subtle` is the design system's, `solid` is what is still here. */
  tone?: BandTone;
}) {
  return (
    <>
      <BreadcrumbSchema items={[...crumbs, { label: title, href: selfPath }]} />

      <div className="kb-noprint border-b border-[var(--kb-border)] bg-[var(--kb-surface)]">
        <Container className="flex flex-wrap items-center gap-3 py-2.5">
          <Breadcrumbs locale={locale} items={crumbs} />
          {search ? (
            <div className="ms-auto w-full sm:w-72">
              <SearchBox locale={locale} initial={searchInitial} />
            </div>
          ) : null}
        </Container>
      </div>

      <Band tone={tone} className={tone === 'subtle' ? 'py-8 lg:py-10' : 'py-7 lg:py-12'}>
        <div className="flex items-start gap-3">
          {icon ? (
            <span
              className={`mt-0.5 shrink-0 ${tone === 'subtle' ? 'text-[var(--kb-band-ink)]' : 'opacity-90'}`}
            >
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold break-words sm:text-3xl">{title}</h1>
            {meta ? (
              <div
                className={`mt-1.5 text-sm ${tone === 'subtle' ? 'text-[var(--kb-muted)]' : 'opacity-80'}`}
              >
                {meta}
              </div>
            ) : null}
          </div>
        </div>
      </Band>
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
 * Two up from `sm`, three from `lg`.
 *
 * Not four, which is where the live portal's home page lands: at four across a
 * category name long enough to be useful — "Lost & Damaged Shipments" — wraps to
 * three lines in Arabic and the row turns ragged.
 */
export function CardGrid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>;
}

/**
 * One article in a list.
 *
 * The document icon is not decoration: in a list that mixes folders and
 * articles — which the category page is — it is the only thing that says
 * whether a link opens an answer or another list.
 */
export function ArticleRow({
  href,
  title,
  excerpt,
  level: Heading = 'h2',
}: {
  href: string;
  title: string;
  excerpt?: string | null;
  level?: 'h2' | 'h3';
}) {
  return (
    <li className="border-b border-[var(--kb-border)] last:border-0">
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--kb-surface-2)]"
      >
        <DocumentIcon size={18} className="mt-0.5 shrink-0 text-[var(--kb-muted)]" />
        <div className="min-w-0">
          <Heading className="font-medium text-[var(--kb-heading)]">{title}</Heading>
          {excerpt ? (
            <p className="mt-0.5 line-clamp-2 text-sm text-[var(--kb-muted)]">{excerpt}</p>
          ) : null}
        </div>
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
export function SectionHeading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  if (!meta) {
    return <h2 className="mb-4 text-lg font-semibold text-[var(--kb-heading)]">{children}</h2>;
  }

  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-lg font-semibold text-[var(--kb-heading)]">{children}</h2>
      <span className="text-sm text-[var(--kb-muted)]">{meta}</span>
    </div>
  );
}

/** Nothing here yet — said once, in a card, so the page still looks finished. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <Panel className="p-8 text-center text-sm text-[var(--kb-muted)]">
      <p>{children}</p>
    </Panel>
  );
}
