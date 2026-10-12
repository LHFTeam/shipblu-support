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
              <span aria-hidden className="text-(--color-border-default)">
                /
              </span>
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
 * The header of every page below the front door: the trail and a search field
 * on the page's own surface, then the title on a pale band.
 *
 * Search is repeated here rather than living only on the home page because a
 * customer who has opened the wrong article should not have to go back to the
 * front door to try a different phrase.
 *
 * The band is the brand's palest tint with a hairline under it, and nothing
 * else. It used to be a full-bleed blue slab, and blue is the action colour —
 * a title painted in it is the loudest thing on the page and says nothing, and
 * it teaches a reader that blue means "here" when everywhere else it means
 * "press". Not no band at all, either: on the grey canvas the hairline is what
 * separates the search chrome from the title, and without it the trail reads
 * as the first line of the page.
 *
 * `container-fluid` in Freshdesk's markup, and the same idea here: the colour
 * runs the full width of the viewport while the text inside stays on the
 * content column.
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
}) {
  return (
    <>
      <BreadcrumbSchema items={[...crumbs, { label: title, href: selfPath }]} />

      <div className="kb-noprint border-b border-(--color-border-subtle) bg-(--color-background-surface)">
        <Container className="flex flex-wrap items-center gap-3 py-2.5">
          <Breadcrumbs locale={locale} items={crumbs} />
          {search ? (
            <div className="ms-auto w-full sm:w-72">
              <SearchBox locale={locale} initial={searchInitial} />
            </div>
          ) : null}
        </Container>
      </div>

      <div className="border-b border-(--color-border-subtle) bg-(--color-background-brand-subtle) text-(--color-text-primary)">
        <Container className="flex items-start gap-3 py-8">
          {icon ? <span className="mt-1 shrink-0 text-(--color-text-brand)">{icon}</span> : null}
          <div className="min-w-0">
            <h1
              className={`text-read-h1 font-bold break-words sm:text-read-h1-md ${
                locale === 'ar' ? 'leading-read-heading-ar' : ''
              }`}
            >
              {title}
            </h1>
            {meta ? (
              <div className="mt-1.5 text-sm text-(--color-text-secondary)">{meta}</div>
            ) : null}
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
    <li className="border-b border-(--color-border-subtle) last:border-0">
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-(--color-background-surface-sunken)"
      >
        <DocumentIcon size={18} className="mt-0.5 shrink-0 text-(--color-text-secondary)" />
        <div className="min-w-0">
          <Heading className="text-base font-bold text-(--color-text-primary)">{title}</Heading>
          {excerpt ? (
            <p className="mt-0.5 line-clamp-2 text-sm text-(--color-text-secondary)">{excerpt}</p>
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
    return <h2 className="mb-4 text-lg font-bold text-(--color-text-primary)">{children}</h2>;
  }

  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-lg font-bold text-(--color-text-primary)">{children}</h2>
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
