import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { supportAvailability } from '@/lib/kb/availability';
import { isLocale, t, tFill } from '@/lib/kb/locale';
import { getFolder, listCategories } from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { decodeSlugParam } from '@/lib/kb/slug';
import { topicArt } from '@/lib/kb/art';
import { TopicArtImage } from '../../../art';
import { ArticleList, ArticleRow, EmptyNote, HelpCta, PageHeader } from '../../../chrome';
import { SearchBox } from '../../../search-box';
import { TopicBody, TopicMeta, TopicNav } from '../../../topic-nav';

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

  const folder = await getFolder(await kbViewer(), locale, categorySlug, folderSlug);
  if (!folder) return {};

  return {
    title: `${folder.name} — ShipBlu Support`,
    description: folder.description || undefined,
    alternates: { canonical: `/${locale}/c/${folder.categorySlug}/${folder.slug}` },
  };
}

/**
 * One folder of a topic, in the same clothes as the topic itself: the band,
 * the Topics list with the folder's category marked, and the folder's articles.
 *
 * The search field searches the whole category rather than the folder. The
 * query layer scopes by category alone, and a folder is small enough — fifteen
 * articles at the most in production — that a reader can see whether their
 * answer is in it; the search is for when it is not, and then the category is
 * where it is likeliest to be.
 */
export default async function FolderPage({
  params,
}: {
  params: Promise<{ locale: string; category: string; folder: string }>;
}) {
  const { locale, category, folder: folderParam } = await params;
  const categorySlug = decodeSlugParam(category);
  const folderSlug = decodeSlugParam(folderParam);
  if (!isLocale(locale)) notFound();

  const viewer = await kbViewer();
  const [folder, topics, availability] = await Promise.all([
    getFolder(viewer, locale, categorySlug, folderSlug),
    listCategories(viewer, locale),
    supportAvailability(),
  ]);
  if (!folder) notFound();

  // The folder's own drawing when its name names a subject ("Financials"), and
  // its category's when it does not ("FAQs"), so the band is not bare on the
  // folders whose names say least.
  const art =
    topicArt(folder.name, folder.slug) ?? topicArt(folder.categoryName, folder.categorySlug);

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
        accent
        lede={folder.description?.trim() || undefined}
        meta={
          <TopicMeta
            locale={locale}
            count={folder.articles.length}
            updatedAt={folder.lastUpdatedAt}
          />
        }
        art={<TopicArtImage locale={locale} art={art} className="kb-art-fade w-[260px]" priority />}
        search={false}
      >
        <div className="max-w-[32.5rem]">
          <SearchBox
            locale={locale}
            size="field"
            id="kb-topic-search"
            placeholder={tFill(locale, 'searchIn', { name: folder.categoryName })}
            within={folder.categorySlug}
          />
        </div>
      </PageHeader>

      <TopicBody
        nav={
          <TopicNav
            locale={locale}
            categories={topics}
            currentSlug={folder.categorySlug}
            currentIsPage={false}
          />
        }
      >
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

        <HelpCta
          locale={locale}
          title={t(locale, 'ctaNotFoundTitle')}
          availability={availability}
        />
      </TopicBody>
    </>
  );
}
