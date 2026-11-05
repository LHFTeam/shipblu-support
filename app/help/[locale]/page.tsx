import { notFound } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { supportAvailability } from '@/lib/kb/availability';
import { articleCount, isLocale, t } from '@/lib/kb/locale';
import {
  listTopicFolders,
  popularArticles,
  popularTags,
  recentlyUpdatedArticles,
} from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { Container, EmptyNote, SectionHeading } from './chrome';
import {
  ArticleShortlist,
  ContactPanel,
  HomeHero,
  popularShortlist,
  recentShortlist,
  TopicGroups,
} from './home';

export const dynamic = 'force-dynamic';

/**
 * The front door.
 *
 * Four things, in the order a visitor wants them: the two questions they arrive
 * with (a phrase to search, or a parcel to find), the topics, the answers other
 * people needed, and only then how to reach a human. Everything on the page is
 * read from what is actually in the knowledge base, and each block below
 * removes itself when there is nothing to put in it — a freshly imported help
 * centre with no views and no tags renders as the front page it can honestly
 * be, not as a page of empty furniture.
 *
 * All six reads go out at once. They are independent, they hit different
 * indexes, and awaiting them in sequence would make the front page — the most
 * requested page on the site — six round trips deep.
 *
 * The body is a `Container` with the design's own 48px between sections rather
 * than `PageBody`, whose shorter top suits a page that opens under a header
 * band's title; this one opens under the hero, and the topics need the air.
 */
export default async function HelpCentreHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const viewer = await kbViewer();

  const [groups, popular, recent, tags, availability, customer] = await Promise.all([
    listTopicFolders(viewer, locale),
    popularArticles(viewer, locale),
    recentlyUpdatedArticles(viewer, locale),
    popularTags(viewer, locale),
    supportAvailability(),
    getSessionCustomer(),
  ]);

  const total = groups.reduce((sum, group) => sum + group.articleCount, 0);

  return (
    <>
      <HomeHero locale={locale} tags={tags} />

      <Container className="flex flex-col gap-10 pt-10 pb-12 sm:gap-12 sm:pt-12 sm:pb-16">
        <section>
          {/* The count alone: the design adds "updated weekly", which nothing
              here schedules or measures. */}
          <SectionHeading id="topics" meta={total > 0 ? articleCount(locale, total) : null}>
            {t(locale, 'browseTopics')}
          </SectionHeading>

          {groups.length === 0 ? (
            <EmptyNote>{t(locale, 'emptyCategory')}</EmptyNote>
          ) : (
            <TopicGroups locale={locale} groups={groups} />
          )}
        </section>

        {popular.length > 0 || recent.length > 0 ? (
          <div className="grid gap-8 md:grid-cols-2">
            {/* "Most read", not the design's "this month": `view_count` is
                every read the article has had, not a month of them. */}
            <ArticleShortlist
              locale={locale}
              title={t(locale, 'mostRead')}
              ordered
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
      </Container>
    </>
  );
}
