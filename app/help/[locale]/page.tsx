import { notFound } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { supportAvailability } from '@/lib/kb/availability';
import { articleCount, isLocale, t } from '@/lib/kb/locale';
import {
  listCategoryPreviews,
  popularArticles,
  popularTags,
  recentlyUpdatedArticles,
} from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { CardGrid, EmptyNote, PageBody, SectionHeading } from './chrome';
import {
  ArticleShortlist,
  ContactPanel,
  HomeHero,
  popularShortlist,
  recentShortlist,
  TopicCard,
} from './home';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * Four things, in the order a visitor wants them: the two questions they arrive
 * with (a phrase to search, or a parcel to find), the topics, the answers other
 * people needed this month, and only then how to reach a human. Everything on
 * the page is read from what is actually in the knowledge base, and each block
 * below removes itself when there is nothing to put in it — a freshly imported
 * help centre with no views and no tags renders as the front page it can honestly
 * be, not as a page of empty furniture.
 *
 * All six reads go out at once. They are independent, they hit different
 * indexes, and awaiting them in sequence would make the front page — the most
 * requested page on the site — six round trips deep.
 */
export default async function HelpCentreHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const viewer = await kbViewer();

  const [categories, popular, recent, tags, availability, customer] = await Promise.all([
    listCategoryPreviews(viewer, locale),
    popularArticles(viewer, locale),
    recentlyUpdatedArticles(viewer, locale),
    popularTags(viewer, locale),
    supportAvailability(),
    getSessionCustomer(),
  ]);

  const total = categories.reduce((sum, category) => sum + category.articleCount, 0);

  return (
    <>
      <HomeHero locale={locale} tags={tags} />

      <PageBody className="flex flex-col gap-10">
        <section>
          <SectionHeading meta={total > 0 ? articleCount(locale, total) : null}>
            {t(locale, 'browseTopics')}
          </SectionHeading>

          {categories.length === 0 ? (
            <EmptyNote>{t(locale, 'emptyCategory')}</EmptyNote>
          ) : (
            <CardGrid>
              {categories.map((category) => (
                <TopicCard key={category.id} locale={locale} category={category} />
              ))}
            </CardGrid>
          )}
        </section>

        {popular.length > 0 || recent.length > 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <ArticleShortlist
              locale={locale}
              title={t(locale, 'mostRead')}
              articles={popularShortlist(popular)}
            />
            <ArticleShortlist
              locale={locale}
              title={t(locale, 'recentlyUpdated')}
              articles={recentShortlist(locale, recent)}
            />
          </div>
        ) : null}

        <ContactPanel locale={locale} availability={availability} signedIn={Boolean(customer)} />
      </PageBody>
    </>
  );
}
