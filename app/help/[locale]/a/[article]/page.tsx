import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  ArrowRightIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ClockIcon,
  GlobeIcon,
} from '@/components/icons';
import { supportAvailability } from '@/lib/kb/availability';
import { formatArticleDate } from '@/lib/kb/dates';
import { isLocale, LOCALE_NAMES, readingTime, t, type Locale } from '@/lib/kb/locale';
import {
  articleOutline,
  excerptRepeatsOpening,
  readingMinutes,
  type ArticleSection,
} from '@/lib/kb/outline';
import {
  folderNeighbours,
  getArticle,
  translationsOf,
  type ArticleSummary,
} from '@/lib/kb/queries';
import { kbViewer } from '@/lib/kb/viewer';
import { publicBaseUrl } from '@/lib/kb/site';
import { decodeSlugParam } from '@/lib/kb/slug';
import { viewerIsTeamMember } from '@/lib/widget/audience';
import { HelpCta, PageBody, PageHeader } from '../../chrome';
import { ArticleFeedback } from './feedback';
import { PrintButton } from './print-button';
import { ViewBeacon } from './view-beacon';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; article: string }>;
}): Promise<Metadata> {
  const { locale, article: articleParam } = await params;
  const slug = decodeSlugParam(articleParam);
  if (!isLocale(locale)) return {};

  const viewer = await kbViewer();

  const article = await getArticle(viewer, locale, slug);
  if (!article) return {};

  const translations = await translationsOf(viewer, article.translationGroupId);

  return {
    title: article.seo.title ?? `${article.title} — ShipBlu Support`,
    description: article.seo.description ?? article.excerpt ?? undefined,
    alternates: {
      canonical: `/${locale}/a/${article.slug}`,
      // Tells search engines these are translations of one another rather than
      // duplicates, which is what stops the Arabic page cannibalising the
      // English one in results.
      languages: Object.fromEntries(
        translations.map((entry) => [entry.locale, `/${entry.locale}/a/${entry.slug}`]),
      ),
    },
    openGraph: {
      title: article.title,
      description: article.excerpt ?? undefined,
      type: 'article',
      locale,
    },
  };
}

/**
 * An article: the header band with its facts, the body on the canvas, "On this
 * page" and the folder's other articles in a rail beside it, then the feedback
 * question, the way on and the "Stuck on a step?" band.
 *
 * The design also draws an audience line in the meta row — "For merchants".
 * It is not here: an article carries no audience, and the category in the trail
 * above already says which of production's two it is written for.
 */
export default async function ArticlePage({
  params,
}: {
  params: Promise<{ locale: string; article: string }>;
}) {
  const { locale, article: articleParam } = await params;
  const slug = decodeSlugParam(articleParam);
  if (!isLocale(locale)) notFound();

  const viewer = await kbViewer();

  const article = await getArticle(viewer, locale, slug);
  if (!article) notFound();

  // "Next article" and the rail's related list come from one read of the folder
  // (`folderNeighbours`), the related list already without the next article, so
  // the rail does not spend one of its few places on a link the reader is about
  // to meet under the body anyway.
  const [{ next, related: rail }, translations, availability, teamMember] = await Promise.all([
    folderNeighbours(viewer, locale, article.folderId, article.id),
    translationsOf(viewer, article.translationGroupId),
    supportAvailability(),
    viewerIsTeamMember(),
  ]);

  const others = translations.filter((entry) => entry.locale !== locale);
  const outline = articleOutline(article.bodyHtml);

  // One heading is not an outline: a rail offering a single link to the only
  // section there is promises a structure the article does not have.
  const sections = outline.sections.length >= 2 ? outline.sections : [];

  const hasRail = sections.length > 0 || rail.length > 0;

  return (
    <>
      <ViewBeacon articleId={article.id} />

      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: article.categoryName, href: `/${locale}/c/${article.categorySlug}` },
          {
            label: article.folderName,
            href: `/${locale}/c/${article.categorySlug}/${article.folderSlug}`,
          },
        ]}
        title={article.title}
        selfPath={`/${locale}/a/${article.slug}`}
        /* Only an excerpt somebody wrote for the article. The stored one is
           usually the body's own first 200 characters (`articleBody`), which
           as a lede printed the opening twice, the first time cut mid-word. */
        lede={
          article.excerpt && !excerptRepeatsOpening(article.excerpt, article.bodyText)
            ? article.excerpt.trim()
            : undefined
        }
        meta={
          <>
            <MetaItem icon={<ClockIcon size={14} />}>
              {readingTime(locale, readingMinutes(article.bodyHtml))}
            </MetaItem>
            <MetaItem icon={<CalendarIcon size={14} />}>
              {t(locale, 'updated')}{' '}
              <time dateTime={article.updatedAt.toISOString()}>
                {formatArticleDate(locale, article.updatedAt)}
              </time>
            </MetaItem>
            {/* A link is dead text on paper, and the other language's page is
                no use to whoever is handed the printout. */}
            {others.map((entry) => (
              <MetaItem key={entry.locale} icon={<GlobeIcon size={14} />} className="kb-noprint">
                <Link
                  href={`/${entry.locale}/a/${entry.slug}`}
                  lang={entry.locale}
                  hrefLang={entry.locale}
                  className="text-(--color-text-link) underline underline-offset-4 hover:text-(--color-text-link-hover)"
                >
                  {LOCALE_NAMES[entry.locale as Locale] ?? entry.locale}
                </Link>
              </MetaItem>
            ))}
            <PrintButton locale={locale} />
          </>
        }
      />

      <PageBody>
        {/*
          One column on a phone, the article then the rail. From `lg` the rail is
          a fixed 15rem — the design's 240px — and the article takes what is
          left, capped at 72ch, which keeps the measure roughly constant instead
          of stretching with the viewport: long lines are the fastest way to make
          somebody lose their place mid-procedure. Without a rail the article
          keeps the same measure and the same start edge, so a short article
          does not read as a different kind of page.

          `items-start` is what lets the rail stick: a grid item stretched to
          the row's height has nowhere to travel. And one column on paper,
          whatever the sheet's width, since the rail does not print.
        */}
        <div
          className={`grid grid-cols-1 items-start gap-10 print:block ${
            hasRail ? 'lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-12' : ''
          }`}
        >
          {/*
            `min-w-0` is not decoration. A grid track sized `auto` takes its floor
            from the item's min-content width, and an imported article's widest
            code block or table sets that floor several hundred pixels past a
            phone viewport — the track grows, and the whole document scrolls
            sideways instead of the code block scrolling inside itself.
          */}
          <article className="flex min-w-0 max-w-[72ch] flex-col gap-8 print:max-w-none">
            {/*
              Sanitised on write, in the console action and in the importer,
              never here — so the stored row is safe for every consumer rather
              than only for this page. Re-sanitising on read would hide a gap
              upstream. `articleOutline` adds an id to each `<h2>` that lacks
              one, a value of its own making, and changes nothing else.

              Drawn on the canvas rather than in a white card, as the design
              has it: the card is what the feedback question and the links
              after it are drawn in, and an article in one too made the page a
              stack of boxes with the answer as just one of them.
            */}
            {/*
              For a signed-in agent only, who reads here on the console's own
              host: the queue's help-centre link and the knowledge panel's
              Open both bring them here, so their session keeps the chat
              launcher off the page (`articleOrigins` in `lib/kb/site.ts`).
              That host is the Render service URL once `KB_PUBLIC_HOST` names
              the help centre's, so the address bar is not the link to send a
              customer; this is. English, like the console it belongs to.
              Decided per viewer, which this page may do only because it is
              `force-dynamic`.
            */}
            {teamMember ? (
              <p dir="ltr" lang="en" className="kb-noprint text-sm text-(--color-text-secondary)">
                For the team: the link to send a customer is{' '}
                <span className="break-all text-(--color-text-primary) select-all">
                  {`${publicBaseUrl()}/${locale}/a/${encodeURI(article.slug)}`}
                </span>
              </p>
            ) : null}

            <div className="kb-article" dangerouslySetInnerHTML={{ __html: outline.html }} />

            <ArticleFeedback articleId={article.id} locale={locale} />

            <ArticlePager
              locale={locale}
              category={{ name: article.categoryName, slug: article.categorySlug }}
              next={next}
            />
          </article>

          {hasRail ? <ArticleRail locale={locale} sections={sections} related={rail} /> : null}
        </div>

        <HelpCta
          locale={locale}
          title={t(locale, 'ctaStuckTitle')}
          availability={availability}
          className="mt-12 lg:mt-16"
        />
      </PageBody>
    </>
  );
}

/** One fact in the header's meta row: its glyph, then its words. */
function MetaItem({
  icon,
  className = '',
  children,
}: {
  icon: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="flex shrink-0 text-(--color-text-tertiary)">{icon}</span>
      <span>{children}</span>
    </span>
  );
}

/**
 * The small capitals over each half of the rail. Capitals and letter-spacing in
 * Latin only, as the Topics list has them: Arabic has no case, and tracking
 * pulls its joined letters apart.
 */
function eyebrowClass(locale: Locale) {
  return `mb-2.5 text-2xs font-semibold text-(--color-text-tertiary) ${
    locale === 'ar' ? '' : 'tracking-eyebrow uppercase'
  }`;
}

/**
 * The rail at the article's inline end: "On this page", then the folder's other
 * articles.
 *
 * Sticky from `lg`, and a scroll box of its own there once it is taller than
 * the window — seven long headings and five related titles can be — so its
 * foot is never stuck below the fold for the length of the article. The padding
 * it takes back with a negative margin is room for a link's focus ring, which
 * the scroll box would otherwise clip.
 *
 * Below `lg` the outline is left out and the related list follows the article.
 * An outline is for choosing where to start reading; placed after the text, it
 * is a list of what the reader has just read. The related list is worth as much
 * after the text as beside it — it is where somebody whose answer was not here
 * goes next.
 */
function ArticleRail({
  locale,
  sections,
  related,
}: {
  locale: Locale;
  sections: ArticleSection[];
  related: ArticleSummary[];
}) {
  return (
    <aside
      className={`kb-noprint flex flex-col gap-8 lg:sticky lg:top-21 lg:-m-1 lg:max-h-[calc(100dvh-6.5rem)] lg:overflow-y-auto lg:p-1 ${
        related.length === 0 ? 'max-lg:hidden' : ''
      }`}
    >
      {sections.length > 0 ? (
        <nav aria-labelledby="kb-outline-label" className="max-lg:hidden">
          <p id="kb-outline-label" className={eyebrowClass(locale)}>
            {t(locale, 'onThisPage')}
          </p>
          {/*
            The hairline is the list's inline-start border, and each link draws
            its own over it, transparent until hovered: a logical border rather
            than the design's `border-left`, so it is on the right of an Arabic
            page, where its text starts.
          */}
          <ul className="flex flex-col border-s border-(--color-border-subtle)">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${encodeURIComponent(section.id)}`}
                  className="-ms-px block border-s border-transparent py-1.5 ps-3.5 text-sm leading-snug text-(--color-text-secondary) transition-colors hover:border-(--color-action-primary-default) hover:text-(--color-text-primary)"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      {related.length > 0 ? (
        <section aria-labelledby="kb-related-label">
          <h2 id="kb-related-label" className={eyebrowClass(locale)}>
            {t(locale, 'relatedArticles')}
          </h2>
          <ul className="flex flex-col gap-2.5">
            {related.map((entry) => (
              <li key={entry.id} className="text-sm leading-snug">
                <Link
                  href={`/${locale}/a/${entry.slug}`}
                  className="text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  );
}

const PAGER_CARD =
  'flex flex-col gap-1 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) px-4 py-3.5 transition-colors hover:bg-(--color-background-hover)';

const PAGER_LABEL = 'inline-flex items-center gap-1 text-2xs text-(--color-text-tertiary)';

const PAGER_TITLE = 'text-sm leading-snug font-medium text-(--color-text-link)';

/**
 * "Back to topic" and "Next article", the two ways on from the foot of an
 * article.
 *
 * Back goes to the topic — the category — rather than the folder, as the design
 * has it: the topic page lists this folder's articles and every other folder's
 * beside them, so the same click opens the larger map. Next is the folder's next
 * article in the editor's order (`folderNeighbours`), and is left out on the last
 * one rather than wrapping round to the first, which would read as more to come.
 *
 * Two columns from `sm` whatever is in them, so a lone "Back" takes half the row
 * and never stretches into a bar that looks like a button. "Next" keeps to the
 * inline end, the side a reader's eye is already travelling to.
 */
function ArticlePager({
  locale,
  category,
  next,
}: {
  locale: Locale;
  category: { name: string; slug: string };
  next: { slug: string; title: string } | null;
}) {
  return (
    <nav aria-label={t(locale, 'articleNavLabel')} className="kb-noprint grid gap-3 sm:grid-cols-2">
      <Link href={`/${locale}/c/${category.slug}`} className={PAGER_CARD}>
        <span className={PAGER_LABEL}>
          <ChevronLeftIcon size={14} className="shrink-0" />
          {t(locale, 'backToTopic')}
        </span>
        <span className={PAGER_TITLE}>{category.name}</span>
      </Link>

      {next ? (
        <Link href={`/${locale}/a/${next.slug}`} className={`${PAGER_CARD} items-end text-end`}>
          <span className={PAGER_LABEL}>
            {t(locale, 'nextArticle')}
            <ArrowRightIcon size={14} className="shrink-0" />
          </span>
          <span className={PAGER_TITLE}>{next.title}</span>
        </Link>
      ) : null}
    </nav>
  );
}
