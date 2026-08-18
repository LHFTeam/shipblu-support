import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isLocale, t } from '@/lib/kb/locale';
import { getCategory } from '@/lib/kb/queries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}): Promise<Metadata> {
  const { locale, category: slug } = await params;
  if (!isLocale(locale)) return {};

  const category = await getCategory(locale, slug);
  if (!category) return {};

  return {
    title: `${category.name} — ShipBlu Support`,
    description: category.description ?? undefined,
  };
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}) {
  const { locale, category: slug } = await params;
  if (!isLocale(locale)) notFound();

  const category = await getCategory(locale, slug);
  if (!category) notFound();

  return (
    <>
      <nav className="mb-4 text-sm opacity-60">
        <Link href={`/${locale}`} className="hover:opacity-100">
          {t(locale, 'home')}
        </Link>
      </nav>

      <h1 className="mb-1 text-2xl font-semibold">{category.name}</h1>
      {category.description ? (
        <p className="mb-6 opacity-70">{category.description}</p>
      ) : (
        <div className="mb-6" />
      )}

      {category.folders.length === 0 ? (
        <p className="opacity-60">{t(locale, 'emptyCategory')}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {category.folders.map((folder) => (
            <li key={folder.id}>
              <Link
                href={`/${locale}/c/${category.slug}/${folder.slug}`}
                className="block rounded-lg border border-[var(--border)] p-4 transition-colors hover:bg-[var(--muted)]"
              >
                <h2 className="font-medium">{folder.name}</h2>
                {folder.description ? (
                  <p className="mt-1 text-sm opacity-70">{folder.description}</p>
                ) : null}
                <p className="mt-2 text-xs opacity-50">
                  {folder.articleCount} {t(locale, 'articles')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
