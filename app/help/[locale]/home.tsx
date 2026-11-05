import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRightIcon, DocumentIcon, ListIcon, MailIcon } from '@/components/icons';
import type { SupportAvailability } from '@/lib/kb/availability';
import { formatArticleDate } from '@/lib/kb/dates';
import { formatCount, t, tCount, type Locale } from '@/lib/kb/locale';
import type { DatedArticle, RankedArticle, TopicFolder, TopicGroup } from '@/lib/kb/queries';
import { topicArt } from '@/lib/kb/art';
import { SupportArt, TopicArtImage, TrackingArt } from './art';
import { AccentTitle, Availability, Container, Panel } from './chrome';
import { SearchBox } from './search-box';
import { TrackForm } from './track/form';
import { AskSupport } from './track/support';

/**
 * The front page, and only the front page.
 *
 * Kept out of `chrome.tsx` deliberately: that file holds the shapes every help
 * centre page is built from, and everything here is used exactly once. Mixing
 * the two is how a "shared" component ends up with a `variant` prop that only
 * one caller ever passes.
 *
 * The layout is the help-centre design's ("ShipBlu support landing page v02"
 * in Claude Design), drawn over what the knowledge base actually holds: the
 * design's subject cards are production's folders, grouped under the two
 * audiences they belong to, and the lists are only as long as the reads behind
 * them.
 */

/**
 * The front door.
 *
 * Search on the start side at the weight it earns — most people arrive with a
 * phrase, not a category — and the parcel lookup beside it rather than under
 * it. The two are different questions asked by different people: a merchant
 * searching for how settlement works, and a recipient who wants to know where
 * their box is. Stacking them would have made the second look like a footnote
 * to the first. On a phone, where there is no room beside, they stack with
 * search first, as the design reads them.
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
      <Container className="grid items-center gap-8 pt-10 pb-12 sm:pt-12 sm:pb-14 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-12">
        <div>
          {/* Capitals and letter-spacing in Latin only: Arabic has no case, and
              tracking pulls its joined letters apart. Arabic takes a size up
              instead, as the design's Arabic page does, since at 11px its
              letters lose the dots that tell them apart. */}
          <p
            className={`font-semibold text-(--color-text-brand) ${
              locale === 'ar' ? 'text-[0.8125rem]' : 'text-2xs tracking-eyebrow uppercase'
            }`}
          >
            {t(locale, 'heroEyebrow')}
          </p>

          <h1
            className={`mt-2.5 text-read-display font-semibold text-balance text-(--color-text-primary) md:text-read-display-md ${
              locale === 'ar' ? 'leading-read-heading-ar' : 'tracking-tight'
            }`}
          >
            <AccentTitle text={t(locale, 'heroHeading')} at="last" />
          </h1>

          <p className="mt-3 max-w-[52ch] text-read-ui text-(--color-text-secondary)">
            {t(locale, 'heroIntro')}
          </p>

          <div className="mt-6 max-w-[37.5rem]">
            <SearchBox locale={locale} size="hero" placeholderKey="searchPlaceholderHero" />
          </div>

          {tags.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-baseline gap-2 text-sm">
              {/* Secondary, not the design's tertiary: tertiary on this band is
                  4.49:1, a hair under AA for 14px text. */}
              <span className="text-(--color-text-secondary)">{t(locale, 'commonSearches')}</span>
              {/* Each tag on one line — a two-word Arabic phrase broken across
                  a pill reads as two searches — and cut short only when it is
                  longer than the whole row, which no tag written as a search
                  should be. */}
              {tags.map((tag) => (
                <Link
                  key={tag}
                  href={`/${locale}/search?q=${encodeURIComponent(tag)}`}
                  // `focus-visible:rounded-full!`: the global focus rule sets a
                  // 4px radius, which squared the pill off while focused.
                  className="max-w-full truncate rounded-full border border-(--color-border-subtle) bg-(--color-background-surface) px-2.5 py-1 text-xs text-(--color-text-secondary) transition-colors hover:border-(--color-border-default) hover:bg-(--color-background-hover) hover:text-(--color-text-primary) focus-visible:rounded-full!"
                >
                  {tag}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        <TrackingCard locale={locale} />
      </Container>
    </div>
  );
}

/**
 * The parcel lookup, with the parcel-and-pin drawing perched on its top end
 * corner.
 *
 * The drawing hangs 72px above the card and the card's top margin is 56px of
 * that, as the design has it, so the drawing reaches only 16px into the gap
 * above the card — on a phone, where the card follows the common searches,
 * that keeps it off them — and it sits at the end side, clear of the heading
 * at the start. Below `lg` the card is held to the search field's width rather
 * than stretched across a tablet, where its full-width button would be the
 * widest thing on the page.
 */
function TrackingCard({ locale }: { locale: Locale }) {
  return (
    <Panel className="relative mt-14 w-full max-w-[37.5rem] p-5 lg:max-w-none">
      <TrackingArt className="absolute -top-18 end-3 w-[150px]" />
      <h2 className="text-lg font-semibold text-(--color-text-primary)">
        {t(locale, 'trackTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-(--color-text-secondary)">
        {t(locale, 'trackIntro')}
      </p>
      <div className="mt-3.5">
        <TrackForm locale={locale} id="home-tracking" layout="stacked" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-(--color-text-tertiary)">
        {t(locale, 'trackHint')}
      </p>
    </Panel>
  );
}

/**
 * "Browse by topic": one group per audience, a card per folder in each.
 *
 * The design's six cards are subjects, and production's subjects are its
 * folders, so a card is a folder (`listTopicFolders`). The audiences the
 * folders sit under — the merchants' and the recipients' — head their own
 * groups, each with a link to the audience's page, because "FAQs" means a
 * different list to each of them and a card alone cannot say whose it is.
 */
export function TopicGroups({ locale, groups }: { locale: Locale; groups: TopicGroup[] }) {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`topic-group-${group.id}`}>
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3
              id={`topic-group-${group.id}`}
              className="text-base font-semibold text-(--color-text-primary)"
            >
              {group.name}
            </h3>
            <Link
              href={`/${locale}/c/${group.slug}`}
              // The visible words first, then whose: ten "All articles (N)"
              // links on one page read alike in a screen reader's links list.
              aria-label={`${tCount(locale, 'allArticles', group.articleCount)} — ${group.name}`}
              className="text-xs font-medium text-(--color-text-link) underline-offset-2 hover:text-(--color-text-link-hover) hover:underline"
            >
              {tCount(locale, 'allArticles', group.articleCount)}
            </Link>
          </div>
          <TopicGrid>
            {group.folders.map((folder) => (
              <TopicCard
                key={folder.id}
                locale={locale}
                categorySlug={group.slug}
                folder={folder}
              />
            ))}
          </TopicGrid>
        </section>
      ))}
    </div>
  );
}

/**
 * The topic cards' grid: the design's three across, two on a tablet, one on a
 * phone.
 *
 * Three across in every group, the recipients' two cards included, so a card
 * is the same size wherever it sits and the two groups' columns line up. The
 * short row is a group's last one under its own heading, not a hole in one
 * grid where a card failed to load.
 *
 * Each card takes two of its rows, band and list, as a subgrid (`TopicCard`),
 * so the bands of one row are one height and their dividers one line, whatever
 * each topic's name, description or drawing makes its own band want.
 */
function TopicGrid({ children }: { children: ReactNode }) {
  return <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>;
}

/**
 * A topic: a pale band naming the folder, with its description and drawing,
 * and the first three answers inside it under that.
 *
 * The titles are the point. A folder name is a guess at what is behind it;
 * three titles are the thing itself, and a visitor who spots the one they came
 * for skips the folder page entirely.
 *
 * The description is never clamped, as in the design: the lines are ours
 * (`db/sql/010_kb_folder_descriptions.sql`) and short, and a longer one only
 * deepens its row, whose bands the subgrid keeps one height.
 *
 * The band's 148px is the drawing's room. A folder `topicArt` does not
 * recognise gets no drawing and no minimum height either, so its band closes
 * round the name as a plain header strip rather than standing as a pale box
 * with a gap where a picture should be.
 *
 * The border turns the action blue while the pointer is anywhere on the card,
 * or the keyboard is on one of its links, as the design has it: the card is one
 * object with three ways in, and the whole of it answers. `!` because
 * `.kb-panel` is unlayered CSS and outranks a utility (§6.93).
 */
function TopicCard({
  locale,
  categorySlug,
  folder,
}: {
  locale: Locale;
  categorySlug: string;
  folder: TopicFolder;
}) {
  const href = `/${locale}/c/${categorySlug}/${folder.slug}`;
  const art = topicArt(folder.name, folder.slug);
  const drawn = art !== null;

  return (
    // `.kb-panel` on the item itself rather than a `Panel` inside it, because
    // the subgrid's rows have to be the card's own children.
    <li className="kb-panel row-span-2 grid grid-rows-subgrid gap-y-0 overflow-hidden transition-colors focus-within:border-(--color-action-primary-default)! hover:border-(--color-action-primary-default)!">
      <Link
        href={href}
        // Ring drawn inside: the card clips its overflow for the rounded
        // corners, and the global ring, offset outwards, was cut away (§6.93
        // for the `!`).
        className={`flex items-center gap-2 border-b border-(--color-border-subtle) bg-(--color-background-brand-subtle) pt-5 pb-4 ps-5 text-(--color-text-primary) focus-visible:outline-offset-[-2px]! ${
          drawn ? 'min-h-37 pe-2' : 'pe-5'
        }`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h4
            className={`text-lg leading-snug font-semibold break-words ${
              locale === 'ar' ? '' : 'tracking-tight'
            }`}
          >
            {folder.name}
          </h4>
          {folder.description ? (
            <p className="text-sm leading-relaxed text-(--color-text-secondary)">
              {folder.description}
            </p>
          ) : null}
        </div>
        <TopicArtImage
          art={art}
          /* Capped at the band's height less its padding, and drawn inside
             that box: the drawings are not all one shape, and at its natural
             height the parcel alone stretched every band in its row past the
             design's 148px. */
          className="kb-art-fade max-h-28 w-[42%] max-w-35 shrink-0 object-contain"
        />
      </Link>

      <div className="flex flex-col px-5 pt-4 pb-5">
        <ul
          className={`flex flex-col gap-2 text-sm ${
            locale === 'ar' ? 'leading-relaxed' : 'leading-snug'
          }`}
        >
          {folder.preview.map((article) => (
            <li key={article.id}>
              <Link
                href={`/${locale}/a/${article.slug}`}
                className="text-(--color-text-link) underline-offset-2 hover:text-(--color-text-link-hover) hover:underline"
              >
                {article.title}
              </Link>
            </li>
          ))}
        </ul>

        {/* The gap above is on the wrapper, not the link: as padding on the link
            it made the link's own target reach up to the third title's, and two
            targets that touch are easy to miss with a thumb. */}
        <div className="mt-auto pt-3.5">
          <Link
            href={href}
            aria-label={`${tCount(locale, 'allArticles', folder.articleCount)} — ${folder.name}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-(--color-text-link) underline-offset-2 hover:text-(--color-text-link-hover) hover:underline"
          >
            {tCount(locale, 'allArticles', folder.articleCount)}
            <ArrowRightIcon size={14} className="shrink-0" />
          </Link>
        </div>
      </div>
    </li>
  );
}

/**
 * A short list of articles — "most read" and "recently updated" are the same
 * shape with a different end column, and the first is numbered.
 *
 * `meta` is that column, and it is what stops the two lists reading as one
 * duplicated block: a category name says why an article is popular, a date says
 * why it is here at all.
 *
 * Lighter than the topic cards on purpose, as the design draws them: a hairline
 * box with no shadow and regular-weight titles. These are a reader's second
 * thought after the topics, and at the old bold weight six rows of them
 * outshouted the cards above.
 *
 * Only the title is a link, so a screen reader hears the title and not "1,
 * title, ShipBlu Partners" as one name; its `::after` is stretched over the row,
 * so a thumb that lands on the rank or the date still arrives.
 */
export function ArticleShortlist({
  locale,
  title,
  ordered = false,
  articles,
}: {
  locale: Locale;
  title: string;
  /** Numbered 1..n, for a list whose order is the information. */
  ordered?: boolean;
  articles: { id: string; title: string; slug: string; meta: ReactNode }[];
}) {
  if (articles.length === 0) return null;

  const List = ordered ? 'ol' : 'ul';

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-(--color-text-primary)">{title}</h2>
      <List className="rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface)">
        {articles.map((article, index) => (
          <li
            key={article.id}
            className="relative flex items-baseline gap-3 border-b border-(--color-border-subtle) px-4 py-3.5 last:border-0"
          >
            {ordered ? (
              <span className="min-w-[1.125rem] shrink-0 text-xs text-(--color-text-tertiary) tabular-nums">
                {formatCount(locale, index + 1)}
              </span>
            ) : null}
            <Link
              href={`/${locale}/a/${article.slug}`}
              className={`min-w-0 flex-1 text-sm text-(--color-text-primary) underline-offset-2 after:absolute after:inset-0 hover:text-(--color-text-link-hover) hover:underline ${
                locale === 'ar' ? 'leading-relaxed' : 'leading-snug'
              }`}
            >
              {article.title}
            </Link>
            <span className="shrink-0 text-2xs whitespace-nowrap text-(--color-text-tertiary) tabular-nums">
              {article.meta}
            </span>
          </li>
        ))}
      </List>
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
 * schedule the availability line reads. The design's printed opening hours are
 * that line too, for the reason `Availability` gives.
 *
 * `id="contact"` is what the header's Contact link opens, so the band carries
 * the id rather than its heading: the link lands with the drawing in view.
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
    <section
      id="contact"
      aria-labelledby="contact-title"
      className="grid scroll-mt-24 items-center gap-6 rounded-xl border border-(--color-border-subtle) bg-(--color-background-brand-subtle) p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-8"
    >
      <div>
        {/* Pulled 12px toward the start, as the design does, because the
            drawing's own tile has that much empty margin and the headset
            should line up with the heading under it. */}
        <SupportArt className="kb-art-fade-wide -ms-3 mb-3 block max-w-full" />
        <h2
          id="contact-title"
          className={`text-xl font-semibold text-(--color-text-primary) ${
            locale === 'ar' ? '' : 'tracking-tight'
          }`}
        >
          {t(locale, 'contactPrompt')}
        </h2>
        <p className="mt-2.5 text-sm leading-relaxed text-(--color-text-secondary)">
          {t(locale, 'contactIntro')}
        </p>
        <Availability locale={locale} availability={availability} className="mt-3" />
      </div>

      <ul className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <ChannelCard
          href={`/${locale}/forms`}
          chat
          icon={<DocumentIcon size={17} />}
          name={t(locale, 'contactAction')}
          detail={t(locale, 'channelTicketDetail')}
          note={t(locale, 'channelTicketSla')}
        />
        <ChannelCard
          href="mailto:support@shipblu.com"
          icon={<MailIcon size={17} />}
          name={t(locale, 'email')}
          // Isolated, so an Arabic card does not reorder the address around
          // its punctuation.
          detail={<bdi>support@shipblu.com</bdi>}
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
    </section>
  );
}

/**
 * One route to a person, on white so it reads as a thing to press against the
 * pale band it sits on.
 */
function ChannelCard({
  href,
  chat = false,
  icon,
  name,
  detail,
  note,
}: {
  href: string;
  /**
   * Open the chat rather than follow `href`, which stays the link for a page
   * whose chat never loaded. The contact card needs it: with no ticket form
   * built — production has none — `/forms` redirects to a sign-in wall, and the
   * chat, which takes photos too, needs no account (`AskSupport`).
   */
  chat?: boolean;
  icon: ReactNode;
  name: string;
  detail: ReactNode;
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
        <span className="text-sm font-semibold text-(--color-text-primary)">{name}</span>
      </span>
      <span className="text-xs leading-relaxed break-words text-(--color-text-secondary)">
        {detail}
      </span>
      {note ? <span className="mt-auto text-2xs text-(--color-text-tertiary)">{note}</span> : null}
    </>
  );

  const className =
    'flex h-full flex-col gap-1.5 rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) p-4 transition-colors hover:border-(--color-border-default) hover:bg-(--color-background-hover)';

  return (
    <li>
      {chat ? (
        <AskSupport href={href} className={className}>
          {body}
        </AskSupport>
      ) : external ? (
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
