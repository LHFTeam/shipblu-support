import { notFound } from 'next/navigation';
import { CategoryIcon } from '@/components/icons';
import { articleCount, isLocale, t } from '@/lib/kb/locale';
import { listCategories } from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { CardGrid, EmptyNote, Hero, NavCard, PageBody, SectionHeading } from './chrome';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * Search first, then the categories — in that order and with that difference in
 * weight, because those are the two things a customer arriving here can want and
 * the first is far more common than the second. Everything else a help centre
 * home page tends to accumulate is furniture.
 */
export default async function HelpCentreHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const categories = await listCategories(await kbViewer(), locale);

  return (
    <>
      <Hero locale={locale} />

      <PageBody>
        <SectionHeading>{t(locale, 'browseTopics')}</SectionHeading>

        {categories.length === 0 ? (
          <EmptyNote>{t(locale, 'emptyCategory')}</EmptyNote>
        ) : (
          <CardGrid>
            {categories.map((category) => (
              <NavCard
                key={category.id}
                level="h3"
                href={`/${locale}/c/${category.slug}`}
                title={category.name}
                description={category.description}
                footer={articleCount(locale, category.articleCount)}
                icon={<CategoryIcon size={22} />}
              />
            ))}
          </CardGrid>
        )}
      </PageBody>
    </>
  );
}
