import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ChevronRightIcon } from '@/components/icons';
import { supportAvailability } from '@/lib/kb/availability';
import { articleCount, formatCount, isLocale, t, tFill, type Locale } from '@/lib/kb/locale';
import { getCategory, listCategories, type FolderSummary } from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { decodeSlugParam } from '@/lib/kb/slug';
import { topicArt } from '@/lib/kb/art';
import { TopicArtImage } from '../../art';
import { ArticleList, ArticleRow, HelpCta, PageHeader } from '../../chrome';
import { SearchBox } from '../../search-box';
import { TopicBody, TopicMeta, TopicNav } from '../../topic-nav';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}): Promise<Metadata> {
  const { locale, category: categoryParam } = await params;
  const slug = decodeSlugParam(categoryParam);
  if (!isLocale(locale)) return {};

  const category = await getCategory(await kbViewer(), locale, slug);
  if (!category) return {};

  return {
    title: `${category.name} — ShipBlu Support`,
    description: category.description || undefined,
    alternates: { canonical: `/${locale}/c/${category.slug}` },
  };
}

/**
 * A topic: every folder in the category as a section of its own, every article
 * in each, title and excerpt — the design's grouped list.
 *
 * All of them, where this page used to show each folder as a card with three
 * titles and a "View all". Production's biggest category holds forty-odd
 * articles in six folders, which is a list a reader scans in one scroll, and
 * every "View all" was a page load between them and an answer that could have
 * been on screen already.
 *
 * The design also draws a row of audience chips — "For merchants", "For
 * recipients" — over the list. They are not here: an article carries no
 * audience, and in production the categories themselves are the two audiences,
 * which the Topics list beside this one already offers.
 */
export default async function CategoryPage({
  params,
}: {
  params: Promise<{ locale: string; category: string }>;
}) {
  const { locale, category: categoryParam } = await params;
  const slug = decodeSlugParam(categoryParam);
  if (!isLocale(locale)) notFound();

  const viewer = await kbViewer();
  const [category, topics, availability] = await Promise.all([
    getCategory(viewer, locale, slug),
    listCategories(viewer, locale),
    supportAvailability(),
  ]);
  if (!category) notFound();

  const total = category.folders.reduce((sum, folder) => sum + folder.articleCount, 0);

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
        title={category.name}
        selfPath={`/${locale}/c/${category.slug}`}
        accent
        /* Empty in production, where nobody has written one yet: the header
           then goes straight from the title to its facts, rather than leaving a
           gap where a sentence should be. */
        lede={category.description?.trim() || undefined}
        meta={<TopicMeta locale={locale} count={total} updatedAt={category.lastUpdatedAt} />}
        art={
          <TopicArtImage
            art={topicArt(category.name, category.slug)}
            className="kb-art-fade w-[260px]"
            priority
          />
        }
        search={false}
      >
        <div className="max-w-[32.5rem]">
          <SearchBox
            locale={locale}
            size="field"
            id="kb-topic-search"
            placeholder={tFill(locale, 'searchIn', { name: category.name })}
            within={category.slug}
          />
        </div>
      </PageHeader>

      {/*
        No empty state: `getCategory` answers null when nothing inside is
        readable, so this page is a 404 rather than a heading over a note — the
        only thing that keeps a category whose folders are all internal off the
        public help centre, since categories carry no visibility of their own.
      */}
      <TopicBody nav={<TopicNav locale={locale} categories={topics} currentSlug={category.slug} />}>
        {category.folders.map((folder) => (
          <FolderSection
            key={folder.id}
            locale={locale}
            categorySlug={category.slug}
            folder={folder}
          />
        ))}

        <HelpCta
          locale={locale}
          title={t(locale, 'ctaNotFoundTitle')}
          availability={availability}
        />
      </TopicBody>
    </>
  );
}

/**
 * One folder: its name, how many articles it holds, and every one of them.
 *
 * The name links to the folder's own page, which is the address to share for
 * "everything about Financials", and the chevron beside it is what says the
 * heading goes somewhere — a heading in the text colour reads as a label
 * otherwise. The articles are `h3`s under it, so a screen reader's heading list
 * is the same outline a sighted reader sees.
 */
function FolderSection({
  locale,
  categorySlug,
  folder,
}: {
  locale: Locale;
  categorySlug: string;
  folder: FolderSummary;
}) {
  const headingId = `folder-${folder.id}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <h2 id={headingId} className="text-lg font-semibold text-(--color-text-primary)">
          <Link
            href={`/${locale}/c/${categorySlug}/${folder.slug}`}
            className="group inline-flex items-center gap-1 underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
          >
            {folder.name}
            <ChevronRightIcon
              size={16}
              className="shrink-0 text-(--color-text-tertiary) group-hover:text-current"
            />
          </Link>
        </h2>
        <span aria-hidden className="text-xs tabular-nums text-(--color-text-tertiary)">
          {formatCount(locale, folder.articleCount)}
        </span>
        <span className="sr-only">{articleCount(locale, folder.articleCount)}</span>
      </div>

      <ArticleList>
        {folder.articles.map((article) => (
          <ArticleRow
            key={article.id}
            href={`/${locale}/a/${article.slug}`}
            title={article.title}
            excerpt={article.excerpt}
            level="h3"
          />
        ))}
      </ArticleList>
    </section>
  );
}
