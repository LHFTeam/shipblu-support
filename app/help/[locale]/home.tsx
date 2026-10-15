import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  CategoryIcon,
  DocumentIcon,
  ListIcon,
  MailIcon,
  PackageIcon,
  PackagePlusIcon,
  PackageSearchIcon,
  ReturnIcon,
  TruckIcon,
  WalletIcon,
  WarningIcon,
} from '@/components/icons';
import type { SupportAvailability } from '@/lib/kb/availability';
import { formatOpening } from '@/lib/hours';
import { formatArticleDate } from '@/lib/kb/dates';
import { t, tCount, type Locale } from '@/lib/kb/locale';
import type { CategoryPreview, DatedArticle, RankedArticle } from '@/lib/kb/queries';
import { Container, Panel, SectionHeading } from './chrome';
import { SearchBox } from './search-box';
import { TrackForm } from './track/form';

/**
 * The front page, and only the front page.
 *
 * Kept out of `chrome.tsx` deliberately: that file holds the shapes every help
 * centre page is built from, and everything here is used exactly once. Mixing
 * the two is how a "shared" component ends up with a `variant` prop that only
 * one caller ever passes.
 *
 * The layout and the colours are both the design system's now. The colours
 * once came from the live portal instead, so this site and the one customers
 * already used would not look subtly unlike each other during the cutover;
 * that palette has since become the system's own roles, which the console reads
 * too, so there is one set of colours rather than two that agree.
 */

/**
 * The front door.
 *
 * Search on the left at the weight it earns — most people arrive with a phrase,
 * not a category — and the parcel lookup beside it rather than under it. The two
 * are different questions asked by different people: a merchant searching for
 * how settlement works, and a recipient who wants to know where their box is.
 * Stacking them would have made the second look like a footnote to the first.
 */
export function HomeHero({
  locale,
  tags,
}: {
  locale: Locale;
  /** One-tap searches. Empty is normal on a knowledge base with no tags yet. */
  tags: string[];
}) {
  return (
    <div className="border-b border-(--color-border-subtle) bg-(--color-background-brand-subtle)">
      <Container className="grid gap-8 py-10 sm:py-14 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
        <div>
          {/* Capitals and letter-spacing in Latin only: Arabic has no case, and
              tracking pulls its joined letters apart. */}
          <p
            className={`text-xs font-bold text-(--color-text-brand) ${
              locale === 'ar' ? '' : 'tracking-eyebrow uppercase'
            }`}
          >
            {t(locale, 'heroEyebrow')}
          </p>

          <h1
            className={`mt-2.5 text-read-display text-balance text-(--color-text-primary) md:text-read-display-md ${
              locale === 'ar' ? 'leading-read-heading-ar font-bold' : 'font-black'
            }`}
          >
            {t(locale, 'heroHeading')}
          </h1>

          <p className="mt-3 max-w-[62ch] text-read-body text-(--color-text-secondary)">
            {t(locale, 'heroIntro')}
          </p>

          <div className="mt-6 max-w-xl">
            <SearchBox locale={locale} size="hero" placeholderKey="searchPlaceholderHero" />
          </div>

          {tags.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-(--color-text-secondary)">{t(locale, 'commonSearches')}</span>
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/${locale}/search?q=${encodeURIComponent(tag)}`}
                  className="rounded-full border border-(--color-border-default) bg-(--color-background-surface) px-3 py-1 text-xs font-medium text-(--color-text-secondary) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
                >
                  {tag}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        <Panel className="self-start p-5">
          <h2 className="flex items-center gap-2 text-base font-bold text-(--color-text-primary)">
            <PackageSearchIcon size={20} className="text-(--color-text-brand)" />
            {t(locale, 'trackTitle')}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-(--color-text-secondary)">
            {t(locale, 'trackIntro')}
          </p>
          <div className="mt-4">
            <TrackForm locale={locale} id="home-tracking" />
          </div>
          <p className="mt-3 text-xs text-(--color-text-secondary)">{t(locale, 'trackHint')}</p>
        </Panel>
      </Container>
    </div>
  );
}

/**
 * A topic, with the first three answers inside it showing.
 *
 * The titles are the point. A category name is a guess at what is behind it;
 * three titles are the thing itself, and a visitor who spots the one they came
 * for skips the category page entirely.
 */
export function TopicCard({ locale, category }: { locale: Locale; category: CategoryPreview }) {
  return (
    <li>
      <Panel className="flex h-full flex-col p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--color-background-brand-subtle) text-(--color-text-brand)">
            <TopicIcon name={category.name} slug={category.slug} />
          </span>
          <h3 className="text-base font-bold text-(--color-text-primary)">
            <Link
              href={`/${locale}/c/${category.slug}`}
              className="underline-offset-4 hover:underline"
            >
              {category.name}
            </Link>
          </h3>
        </div>

        {category.description ? (
          <p className="mt-3 line-clamp-2 text-sm text-(--color-text-secondary)">
            {category.description}
          </p>
        ) : null}

        {category.preview.length > 0 ? (
          <ul className="mt-3.5 flex flex-col gap-2 border-t border-(--color-border-subtle) pt-3.5 text-sm">
            {category.preview.map((article) => (
              <li key={article.id}>
                <Link
                  href={`/${locale}/a/${article.slug}`}
                  className="text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
                >
                  {article.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        <Link
          href={`/${locale}/c/${category.slug}`}
          className="mt-3.5 self-start text-xs font-bold text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
        >
          {tCount(locale, 'allArticles', category.articleCount)}
        </Link>
      </Panel>
    </li>
  );
}

/**
 * Which drawing goes with a topic.
 *
 * Matched on the category's own name, in either language, because nothing in the
 * database says what a category is *about* — `kb_categories` has a name, a slug
 * and a description, and adding an icon column would ask an editor to answer a
 * question they never think about. An unrecognised name gets the generic tile
 * rather than a wrong picture: this is decoration, and decoration that misleads
 * is worse than none.
 */
const TOPIC_ICONS: ReadonlyArray<readonly [ReadonlyArray<string>, typeof CategoryIcon]> = [
  [['start', 'setup', 'account', 'بداية', 'البدء', 'حساب'], PackagePlusIcon],
  [['track', 'shipment', 'parcel', 'تتبع', 'تتبّع', 'شحن', 'شحنات'], PackageSearchIcon],
  [['pickup', 'delivery', 'deliveries', 'courier', 'استلام', 'تسليم', 'توصيل', 'مندوب'], TruckIcon],
  [['return', 'exchange', 'مرتجع', 'مرتجعات', 'استبدال'], ReturnIcon],
  [
    ['payment', 'settlement', 'financial', 'invoice', 'cod', 'مالي', 'ماليات', 'تحصيل', 'فواتير'],
    WalletIcon,
  ],
  [['lost', 'damaged', 'claim', 'مفقود', 'تالف', 'شكوى', 'شكاوى', 'مطالبة'], WarningIcon],
  [['package', 'packaging', 'تغليف'], PackageIcon],
];

function TopicIcon({ name, slug }: { name: string; slug: string }) {
  const haystack = `${name} ${slug}`.toLowerCase();
  const match = TOPIC_ICONS.find(([keywords]) =>
    keywords.some((keyword) => haystack.includes(keyword)),
  );
  const Drawn = match?.[1] ?? CategoryIcon;
  return <Drawn size={19} />;
}

/**
 * A short list of articles in a bordered panel — "most read" and "recently
 * updated" are the same shape with a different right-hand column.
 *
 * `meta` is that column, and it is what stops the two lists reading as one
 * duplicated block: a category name says why an article is popular, a date says
 * why it is here at all.
 */
export function ArticleShortlist({
  locale,
  title,
  articles,
}: {
  locale: Locale;
  title: string;
  articles: { id: string; title: string; slug: string; meta: ReactNode }[];
}) {
  if (articles.length === 0) return null;

  return (
    <section>
      <SectionHeading>{title}</SectionHeading>
      <Panel className="overflow-hidden">
        <ul>
          {articles.map((article) => (
            <li key={article.id} className="border-b border-(--color-border-subtle) last:border-0">
              <Link
                href={`/${locale}/a/${article.slug}`}
                className="flex items-baseline gap-3 px-4 py-3.5 transition-colors hover:bg-(--color-background-surface-sunken)"
              >
                <span className="min-w-0 flex-1 text-base font-bold text-(--color-text-primary)">
                  {article.title}
                </span>
                <span className="shrink-0 text-xs whitespace-nowrap text-(--color-text-secondary)">
                  {article.meta}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  );
}

export function popularShortlist(articles: RankedArticle[]) {
  return articles.map((article) => ({ ...article, meta: article.categoryName }));
}

export function recentShortlist(locale: Locale, articles: DatedArticle[]) {
  return articles.map((article) => ({
    ...article,
    meta: formatArticleDate(locale, article.updatedAt),
  }));
}

/**
 * The bottom of the page: what to do when none of the above answered it.
 *
 * Three routes, and every one of them is something this system can actually
 * deliver today. The redesign also offered a WhatsApp card with a phone number
 * on it; there is no public ShipBlu number anywhere in this codebase or its
 * configuration, and a support channel printed on a help centre has to be one
 * that answers, so it is left out rather than invented. The chat launcher in the
 * corner of this page is the live-chat route, and it gates itself on the same
 * schedule the line below reads.
 */
export function ContactPanel({
  locale,
  availability,
  signedIn,
}: {
  locale: Locale;
  availability: SupportAvailability | null;
  /** Decides whether "your tickets" is offered — it is a sign-in wall otherwise. */
  signedIn: boolean;
}) {
  return (
    <Panel as="section" className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div>
        <h2 className="text-lg font-bold text-(--color-text-primary)">
          {t(locale, 'contactPrompt')}
        </h2>
        <p className="mt-2.5 text-sm leading-relaxed text-(--color-text-secondary)">
          {t(locale, 'contactIntro')}
        </p>
        <Availability locale={locale} availability={availability} />
      </div>

      <ul className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <ChannelCard
          href={`/${locale}/forms`}
          icon={<DocumentIcon size={17} />}
          name={t(locale, 'contactAction')}
          detail={t(locale, 'channelTicketDetail')}
          note={t(locale, 'channelTicketSla')}
        />
        <ChannelCard
          href="mailto:support@shipblu.com"
          icon={<MailIcon size={17} />}
          name={t(locale, 'email')}
          detail="support@shipblu.com"
        />
        {signedIn ? (
          <ChannelCard
            href={`/${locale}/portal`}
            icon={<ListIcon size={17} />}
            name={t(locale, 'myTickets')}
            detail={t(locale, 'channelTicketsDetail')}
            note={t(locale, 'channelTicketsSla')}
          />
        ) : (
          <ChannelCard
            href={`/${locale}/account/login`}
            icon={<ListIcon size={17} />}
            name={t(locale, 'signIn')}
            detail={t(locale, 'channelTicketsDetail')}
            note={t(locale, 'channelTicketsSla')}
          />
        )}
      </ul>
    </Panel>
  );
}

/**
 * "Support is answering now", or when it will be.
 *
 * Rendered from the same schedule the chat widget is gated on, and rendered not
 * at all when no schedule is configured — see `lib/kb/availability.ts`. A help
 * centre that has not been told its own opening hours must not guess at them in
 * front of somebody deciding whether to wait.
 */
function Availability({
  locale,
  availability,
}: {
  locale: Locale;
  availability: SupportAvailability | null;
}) {
  if (!availability) return null;

  if (availability.open) {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm font-bold text-(--color-feedback-success-fg)">
        <span aria-hidden className="size-2 rounded-full bg-current" />
        {t(locale, 'supportOpen')}
      </p>
    );
  }

  const opening = availability.opensAt
    ? t(locale, 'supportOpensAt').replace(
        '{when}',
        formatOpening(availability.opensAt, availability.timezone, locale),
      )
    : t(locale, 'supportClosed');

  return <p className="mt-3 text-sm text-(--color-text-secondary)">{opening}</p>;
}

function ChannelCard({
  href,
  icon,
  name,
  detail,
  note,
}: {
  href: string;
  icon: ReactNode;
  name: string;
  detail: string;
  /**
   * What the route is good for, when there is something true to say. The
   * email card has none: the line it used to carry promised a reply within a
   * business day, which nothing here measures or enforces, and a promise a
   * help centre cannot keep is worse than silence in front of somebody
   * deciding whether to wait.
   */
  note?: string;
}) {
  const external = href.startsWith('mailto:');
  const body = (
    <>
      <span className="flex items-center gap-2 text-(--color-text-brand)">
        {icon}
        <span className="text-sm font-bold text-(--color-text-primary)">{name}</span>
      </span>
      <span className="text-sm break-words text-(--color-text-secondary)">{detail}</span>
      {note ? <span className="mt-auto text-xs text-(--color-text-secondary)">{note}</span> : null}
    </>
  );

  const className =
    'flex h-full flex-col gap-1.5 rounded-lg border border-(--color-border-subtle) p-4 transition-colors hover:border-(--color-border-default) hover:bg-(--color-background-surface-sunken)';

  return (
    <li>
      {external ? (
        <a href={href} className={className}>
          {body}
        </a>
      ) : (
        <Link href={href} className={className}>
          {body}
        </Link>
      )}
    </li>
  );
}
