import { notFound } from 'next/navigation';
import { SearchIcon } from '@/components/icons';
import { articleCount, isLocale, t } from '@/lib/kb/locale';
import { searchArticles } from '@/lib/kb/queries';
import { ArticleList, ArticleRow, EmptyNote, PageBody, PageHeader } from '../chrome';

export const dynamic = 'force-dynamic';

// Search result pages have no business in an index; they are thin, infinite,
// and compete with the articles they link to.
export const metadata = { robots: { index: false, follow: true } };

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ locale }, { q }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const query = (q ?? '').trim();
  const results = query ? await searchArticles(locale, query) : [];

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
        title={`${t(locale, 'resultsFor')} “${query}”`}
        selfPath={`/${locale}/search`}
        icon={<SearchIcon size={28} />}
        searchInitial={query}
        /* The count, not the query — the query is already the heading, and what a
           reader wants next is whether there is anything here to read. */
        meta={articleCount(locale, results.length)}
      />

      <PageBody>
        {results.length === 0 ? (
          <EmptyNote>{t(locale, 'noResults')}</EmptyNote>
        ) : (
          <ArticleList>
            {results.map((hit) => (
              <ArticleRow
                key={hit.id}
                href={`/${locale}/a/${hit.slug}`}
                title={hit.title}
                excerpt={hit.excerpt}
              />
            ))}
          </ArticleList>
        )}
      </PageBody>
    </>
  );
}
