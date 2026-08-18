import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { listCategories } from '@/lib/kb/queries';

export const dynamic = 'force-dynamic';

export default async function HelpCentreHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const categories = await listCategories(locale);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold">{t(locale, 'home')}</h1>

      {categories.length === 0 ? (
        <p className="opacity-60">{t(locale, 'emptyCategory')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {categories.map((category) => (
            <li key={category.id}>
              <Link
                href={`/${locale}/c/${category.slug}`}
                className="block rounded-lg border border-[var(--border)] p-4 transition-colors hover:bg-[var(--muted)]"
              >
                <h2 className="font-medium">{category.name}</h2>
                {category.description ? (
                  <p className="mt-1 text-sm opacity-70">{category.description}</p>
                ) : null}
                <p className="mt-2 text-xs opacity-50">
                  {category.articleCount} {t(locale, 'articles')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
