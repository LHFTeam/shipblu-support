import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isLocale, t } from '@/lib/kb/locale';
import { getFolder } from '@/lib/kb/queries';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; category: string; folder: string }>;
}): Promise<Metadata> {
  const { locale, category, folder: folderSlug } = await params;
  if (!isLocale(locale)) return {};

  const folder = await getFolder(locale, category, folderSlug);
  if (!folder) return {};

  return {
    title: `${folder.name} — ShipBlu Support`,
    description: folder.description ?? undefined,
  };
}

export default async function FolderPage({
  params,
}: {
  params: Promise<{ locale: string; category: string; folder: string }>;
}) {
  const { locale, category, folder: folderSlug } = await params;
  if (!isLocale(locale)) notFound();

  const folder = await getFolder(locale, category, folderSlug);
  if (!folder) notFound();

  return (
    <>
      <nav className="mb-4 flex flex-wrap items-center gap-2 text-sm opacity-60">
        <Link href={`/${locale}`} className="hover:opacity-100">
          {t(locale, 'home')}
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/${locale}/c/${folder.categorySlug}`} className="hover:opacity-100">
          {folder.categoryName}
        </Link>
      </nav>

      <h1 className="mb-1 text-2xl font-semibold">{folder.name}</h1>
      {folder.description ? (
        <p className="mb-6 opacity-70">{folder.description}</p>
      ) : (
        <div className="mb-6" />
      )}

      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {folder.articles.map((article) => (
          <li key={article.id}>
            <Link
              href={`/${locale}/a/${article.slug}`}
              className="block px-4 py-3 transition-colors hover:bg-[var(--muted)]"
            >
              <h2 className="font-medium">{article.title}</h2>
              {article.excerpt ? (
                <p className="mt-0.5 text-sm opacity-60">{article.excerpt}</p>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
