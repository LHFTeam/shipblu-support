import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { FolderIcon } from '@/components/icons';
import { isLocale, t } from '@/lib/kb/locale';
import { getFolder } from '@/lib/kb/queries';
import { decodeSlugParam } from '@/lib/kb/slug';
import { ArticleList, ArticleRow, EmptyNote, PageBody, PageHeader } from '../../../chrome';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; category: string; folder: string }>;
}): Promise<Metadata> {
  const { locale, category, folder: folderParam } = await params;
  const categorySlug = decodeSlugParam(category);
  const folderSlug = decodeSlugParam(folderParam);
  if (!isLocale(locale)) return {};

  const folder = await getFolder(locale, categorySlug, folderSlug);
  if (!folder) return {};

  return {
    title: `${folder.name} — ShipBlu Support`,
    description: folder.description ?? undefined,
    alternates: { canonical: `/${locale}/c/${folder.categorySlug}/${folder.slug}` },
  };
}

export default async function FolderPage({
  params,
}: {
  params: Promise<{ locale: string; category: string; folder: string }>;
}) {
  const { locale, category, folder: folderParam } = await params;
  const categorySlug = decodeSlugParam(category);
  const folderSlug = decodeSlugParam(folderParam);
  if (!isLocale(locale)) notFound();

  const folder = await getFolder(locale, categorySlug, folderSlug);
  if (!folder) notFound();

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: folder.categoryName, href: `/${locale}/c/${folder.categorySlug}` },
        ]}
        title={folder.name}
        selfPath={`/${locale}/c/${folder.categorySlug}/${folder.slug}`}
        icon={<FolderIcon size={28} />}
        meta={folder.description}
      />

      <PageBody>
        {folder.articles.length === 0 ? (
          <EmptyNote>{t(locale, 'emptyCategory')}</EmptyNote>
        ) : (
          <ArticleList>
            {folder.articles.map((article) => (
              <ArticleRow
                key={article.id}
                href={`/${locale}/a/${article.slug}`}
                title={article.title}
                excerpt={article.excerpt}
              />
            ))}
          </ArticleList>
        )}
      </PageBody>
    </>
  );
}
