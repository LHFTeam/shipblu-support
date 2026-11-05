import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatArticleDate } from '@/lib/kb/dates';
import { articleCount, formatCount, t, type Locale } from '@/lib/kb/locale';
import type { CategorySummary } from '@/lib/kb/queries';
import { PageBody } from './chrome';

/**
 * The body of a topic page — a category or one of its folders: the Topics list
 * and the column of articles, the design's `220px` and the rest.
 *
 * One component for both pages so a reader moving from a category into a
 * folder finds the list where it was. Below `lg` the two stack, the list first
 * because it is a single row of pills there (see `TopicNav`).
 */
export function TopicBody({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <PageBody>
      <div className="grid items-start gap-6 lg:grid-cols-[13.75rem_minmax(0,1fr)] lg:gap-10">
        {nav}
        <div className="flex min-w-0 flex-col gap-8">{children}</div>
      </div>
    </PageBody>
  );
}

/**
 * "24 articles · Last updated 4 November 2026", the facts under a topic's title.
 *
 * The date is the newest edit to anything listed rather than to the category
 * row, which nobody edits: it answers "has anything here changed since I last
 * read it", which is the question a returning merchant has. Left off when
 * nothing is listed, since a folder with no articles has no such date.
 */
export function TopicMeta({
  locale,
  count,
  updatedAt,
}: {
  locale: Locale;
  count: number;
  updatedAt: Date | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{articleCount(locale, count)}</span>
      {updatedAt ? (
        <>
          <span aria-hidden>·</span>
          <span>
            {t(locale, 'updated')}{' '}
            <time dateTime={updatedAt.toISOString()}>{formatArticleDate(locale, updatedAt)}</time>
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * The "Topics" list beside a topic's articles: every category the reader may
 * open, with its count, the one they are in marked.
 *
 * One list that changes shape at `lg` rather than two lists, one per screen.
 * From `lg` it is the design's sticky sidebar. Below that it is a row of pills
 * above the articles, because a sidebar stacked over the content on a phone is
 * a screen of navigation before the first answer, and moved under the content it
 * is forty-odd rows away from anybody who wanted it. With production's two
 * categories — the merchants and the people waiting on a parcel — the row is the
 * design's audience chips in all but name, which is what those two are.
 *
 * The current topic is marked four ways, not only by the tint: `aria-current`,
 * the weight, the brand colour, and an accent bar (a ring on a pill). The bar is
 * a pseudo-element on the inline-start edge rather than the design's inset
 * shadow, because a shadow's offset is physical and would sit on the wrong side
 * of an Arabic page.
 */
export function TopicNav({
  locale,
  categories,
  currentSlug,
  currentIsPage = true,
}: {
  locale: Locale;
  categories: CategorySummary[];
  /** The category the page belongs to; null marks none. */
  currentSlug: string | null;
  /**
   * Whether the current topic's link is this very page (the category page) or
   * only the topic the page sits in (a folder). A folder page marking its
   * parent `aria-current="page"` told a screen reader the link led here.
   */
  currentIsPage?: boolean;
}) {
  if (categories.length === 0) return null;

  return (
    <nav aria-labelledby="kb-topics-label" className="kb-noprint lg:sticky lg:top-21">
      {/* Capitals and letter-spacing in Latin only: Arabic has no case, and
          tracking pulls its joined letters apart. */}
      <p
        id="kb-topics-label"
        className={`mb-2.5 text-2xs font-bold text-(--color-text-tertiary) lg:px-3 ${
          locale === 'ar' ? '' : 'tracking-eyebrow uppercase'
        }`}
      >
        {t(locale, 'topicsLabel')}
      </p>

      <ul className="flex flex-wrap gap-2 lg:flex-col lg:flex-nowrap lg:gap-0.5">
        {categories.map((category) => {
          const current = category.slug === currentSlug;

          return (
            <li key={category.id}>
              <Link
                href={`/${locale}/c/${category.slug}`}
                aria-current={current ? (currentIsPage ? 'page' : 'true') : undefined}
                className={`${TOPIC_LINK} ${current ? TOPIC_CURRENT : TOPIC_OTHER}`}
              >
                <span className="min-w-0">{category.name}</span>
                {/* The bare figure, as the design draws it, for sight; the
                    counted noun for a screen reader, which would otherwise read
                    "ShipBlu Partners 24" as two names. */}
                <span
                  aria-hidden
                  className={`shrink-0 text-2xs tabular-nums ${
                    current ? '' : 'text-(--color-text-tertiary)'
                  }`}
                >
                  {formatCount(locale, category.articleCount)}
                </span>
                <span className="sr-only">{articleCount(locale, category.articleCount)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A pill on a phone, a row from `lg`; `relative` and clipped for the accent bar. */
const TOPIC_LINK =
  'relative flex min-h-9 items-center gap-2 overflow-hidden rounded-full border px-3.5 py-1.5 text-sm transition-colors focus-visible:rounded-full! lg:justify-between lg:rounded-md lg:border-transparent lg:px-3 lg:py-2 lg:focus-visible:rounded-md!';

const TOPIC_CURRENT =
  'border-(--color-action-primary-default) bg-(--color-background-selected) font-bold text-(--color-text-brand) lg:before:absolute lg:before:inset-y-0 lg:before:start-0 lg:before:w-0.5 lg:before:bg-(--color-action-primary-default)';

const TOPIC_OTHER =
  'border-(--color-border-subtle) bg-(--color-background-surface) text-(--color-text-secondary) hover:bg-(--color-background-hover) hover:text-(--color-text-primary) lg:bg-transparent lg:hover:bg-(--color-background-hover)';
