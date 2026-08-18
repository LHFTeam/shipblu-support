import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { searchArticles } from '@/lib/kb/queries';
import { SearchBox } from '../search-box';

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
      <div className="mb-6 sm:hidden">
        <SearchBox locale={locale} initial={query} />
      </div>

      <h1 className="mb-6 text-xl font-semibold">
        {t(locale, 'resultsFor')} <span className="opacity-60">“{query}”</span>
      </h1>

      {results.length === 0 ? (
        <p className="opacity-60">{t(locale, 'noResults')}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {results.map((hit) => (
            <li key={hit.id}>
              <Link
                href={`/${locale}/a/${hit.slug}`}
                className="block px-4 py-3 transition-colors hover:bg-[var(--muted)]"
              >
                <h2 className="font-medium">{hit.title}</h2>
                {hit.excerpt ? <p className="mt-0.5 text-sm opacity-60">{hit.excerpt}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
