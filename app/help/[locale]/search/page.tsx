import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ArrowRightIcon, SearchIcon } from '@/components/icons';
import { supportAvailability } from '@/lib/kb/availability';
import { articleCount, isLocale, t, tFill, type Locale } from '@/lib/kb/locale';
import { listCategories, searchArticles } from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { ArticleList, ArticleRow, HelpCta, PageBody, PageHeader, Panel } from '../chrome';
import { SearchBox } from '../search-box';

export const dynamic = 'force-dynamic';

// Search result pages have no business in an index; they are thin, infinite,
// and compete with the articles they link to.
export const metadata = { robots: { index: false, follow: true } };

/** A repeated parameter (`?q=a&q=b`) arrives as an array; the first one wins. */
function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/**
 * Search results, across the help centre or within one category — the target
 * of a topic page's "Search in …" field, which sends the category's slug as `c`.
 *
 * The category is looked up among the ones `listCategories` lets this reader
 * see, never by its slug alone. That list leaves out a category with nothing
 * readable in it, and the title prints the category's name, so a guessed slug
 * cannot turn this page into a way of reading the console handbook's category
 * name — the reason `getCategory` answers null for one. A `c` that names no
 * such category is dropped and the search runs everywhere, which is the more
 * useful answer to a stale link than "no results in a topic you cannot see".
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string | string[]; c?: string | string[] }>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const query = single(search.q);
  const viewer = await kbViewer();
  const [categories, availability] = await Promise.all([
    listCategories(viewer, locale),
    supportAvailability(),
  ]);

  const scope = categories.find((category) => category.slug === single(search.c)) ?? null;
  const results = query ? await searchArticles(viewer, locale, query, 20, scope?.slug) : [];

  // Each result names its category when the search spans several: production's
  // two are the merchants and the people waiting on a parcel, and an answer for
  // the other audience is the near miss a reader most needs warning of.
  const categoryName = new Map(categories.map((category) => [category.slug, category.name]));

  const title = !query
    ? t(locale, 'search')
    : scope
      ? tFill(locale, 'resultsForIn', { q: query, name: scope.name })
      : tFill(locale, 'resultsForQuery', { q: query });

  const everywhere = `/${locale}/search?q=${encodeURIComponent(query)}`;

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          // A scoped search sits under its topic, so the trail is the way back
          // to the list the reader searched from.
          ...(scope ? [{ label: scope.name, href: `/${locale}/c/${scope.slug}` }] : []),
        ]}
        title={title}
        selfPath={`/${locale}/search`}
        /* The count, not the query — the query is already the heading, and what a
           reader wants next is whether there is anything here to read. Not
           "0 articles" over a card saying the same thing in a sentence. */
        meta={results.length > 0 ? articleCount(locale, results.length) : undefined}
        search={false}
      >
        {/* The field under the title rather than at the trail's end, seeded with
            the query: on this page refining the search is the next thing to do,
            and a near miss is edited rather than retyped. It keeps the scope, so
            the edit searches where the first attempt did. */}
        <div className="max-w-[32.5rem]">
          <SearchBox
            locale={locale}
            size="field"
            id="kb-results-search"
            initial={query}
            placeholder={scope ? tFill(locale, 'searchIn', { name: scope.name }) : undefined}
            within={scope?.slug}
          />
        </div>
      </PageHeader>

      <PageBody className="flex flex-col gap-8">
        {!query ? null : results.length === 0 ? (
          <NoResults>
            {scope ? (
              <>
                <p className="text-base font-bold text-(--color-text-primary)">
                  {tFill(locale, 'noResultsIn', { name: scope.name, q: query })}
                </p>
                <EverywhereLink locale={locale} href={everywhere} />
              </>
            ) : (
              <p className="text-base font-bold text-(--color-text-primary)">
                {t(locale, 'noResults')}
              </p>
            )}
          </NoResults>
        ) : (
          <div className="flex flex-col gap-3">
            <ArticleList>
              {results.map((hit) => (
                <ArticleRow
                  key={hit.id}
                  href={`/${locale}/a/${hit.slug}`}
                  title={hit.title}
                  excerpt={hit.excerpt}
                  meta={scope ? undefined : categoryName.get(hit.categorySlug)}
                />
              ))}
            </ArticleList>
            {/* Under a scoped list too, not only an empty one: the answer can
                be in the other audience's topic while this one still matched
                something. */}
            {scope ? (
              <EverywhereLink locale={locale} href={everywhere} className="self-start" />
            ) : null}
          </div>
        )}

        <HelpCta
          locale={locale}
          title={t(locale, 'ctaNotFoundTitle')}
          availability={availability}
        />
      </PageBody>
    </>
  );
}

/** The design's empty topic search: a card, the magnifier, and what to try next. */
function NoResults({ children }: { children: ReactNode }) {
  return (
    <Panel className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <SearchIcon size={24} className="text-(--color-text-tertiary)" />
      {children}
    </Panel>
  );
}

/** The same query, unscoped. */
function EverywhereLink({
  locale,
  href,
  className = '',
}: {
  locale: Locale;
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 text-sm font-bold text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline ${className}`}
    >
      {t(locale, 'searchEverywhere')}
      <ArrowRightIcon size={16} className="shrink-0" />
    </Link>
  );
}
