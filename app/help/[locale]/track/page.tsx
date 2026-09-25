import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { PackageSearchIcon } from '@/components/icons';
import { formatCalendarDate, formatTimestamp, isLocale, t, type Locale } from '@/lib/kb/locale';
import { popularArticles, searchArticles } from '@/lib/kb/queries';
import { allow, clientIpFrom } from '@/lib/kb/rate-limit';
import { kbViewer } from '@/lib/kb/viewer';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import { publicTrackingFor } from '@/lib/shipments/lookup';
import { phraseOverrides } from '@/lib/shipments/phrases';
import {
  RETURN_STEPS,
  returnProgress,
  returnStepLabel,
  stageDisplay,
  statusLabel,
} from '@/lib/shipments/status';
import { shipmentChatPrefill } from '@/lib/shipments/support';
import { ArticleList, ArticleRow, PageBody, PageHeader, Panel } from '../chrome';
import { TrackForm } from './form';
import { deliveryStepLabels, LastUpdate, StatusBadge, Stepper, Timeline } from './result';
import { AskSupport } from './support';

export const dynamic = 'force-dynamic';

/**
 * Never indexed.
 *
 * Every useful URL under this route has somebody's parcel number in it. A search
 * engine that crawled one would publish the number and cache whatever status was
 * showing at the time, which is the one thing a page reachable by anyone holding
 * that number must not do.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * How many lookups one address gets, and over how long.
 *
 * Generous, because a family checking the same parcel from one office NAT is the
 * normal case and must not be throttled. Present at all because this is the one
 * unauthenticated endpoint on the site that answers a question about a specific
 * identifier: without a limit, a script walking the number space learns which
 * numbers exist, one request at a time. It is the same in-memory counter the KB
 * feedback endpoints use, and the same reasoning — a row per rejected request
 * would hand an attacker a cheaper way to hurt the database than the lookup.
 */
const LOOKUPS = 40;
const LOOKUP_WINDOW_MS = 60_000;

/**
 * Where a parcel has got to, for anyone holding its number.
 *
 * Two pages in one route, and the split is on whether a number was asked about
 * rather than on whether one was found: the empty page is a lookup form and
 * nothing else, and the result page is the answer with the form moved aside so a
 * mistyped number can be corrected without going back.
 *
 * What is deliberately *not* here: the recipient's name, their address, their
 * phone number, the cash-on-delivery amount, and every action that would change
 * a delivery. Anyone who has seen the outside of the parcel — a neighbour, a
 * doorman, whoever the merchant forwarded the number to — can open this page, so
 * everything on it is what that person may see. The redesign this follows drew
 * those details behind a "confirm the last four digits of the phone" gate; a
 * four-digit gate on a page anyone can reload is a few thousand guesses, not an
 * identity check, and the phone number it checks against is the thing being
 * protected. Signing in, where the ticket already carries the shipment, is the
 * honest version of that screen and it already exists.
 */
export default async function TrackShipment({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ number?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const typed = (query.number ?? '').trim().slice(0, 40);
  const canonical = normaliseTrackingNumber(typed);

  const header = (
    <PageHeader
      locale={locale}
      crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
      title={t(locale, 'trackTitle')}
      selfPath={`/${locale}/track`}
      icon={<PackageSearchIcon size={28} />}
      search={false}
      tone="subtle"
    />
  );

  if (!canonical) {
    const viewer = await kbViewer();
    const popular = await popularArticles(viewer, locale, 4);

    return (
      <>
        {header}
        <PageBody className="flex flex-col gap-8">
          <Panel className="mx-auto w-full max-w-xl p-6">
            <p className="text-[var(--kb-muted)]">{t(locale, 'trackPrompt')}</p>
            <div className="mt-5">
              <TrackForm locale={locale} id="track-number" initial={typed} autoFocus />
            </div>
            <p className="mt-3 text-xs text-[var(--kb-muted)]">{t(locale, 'trackHint')}</p>
            <p className="mt-4 border-t border-[var(--kb-border)] pt-4 text-xs text-[var(--kb-muted)]">
              {t(locale, 'trackPrivacyNote')}
            </p>
          </Panel>

          <div className="mx-auto w-full max-w-xl">
            <Answers locale={locale} title={t(locale, 'mostRead')} articles={popular} />
          </div>
        </PageBody>
      </>
    );
  }

  return (
    <>
      {header}
      <PageBody className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Lookup locale={locale} canonical={canonical} />
        </div>

        <Panel as="aside" className="p-5">
          <h2 className="font-semibold text-[var(--kb-heading)]">{t(locale, 'trackAnother')}</h2>
          <div className="mt-4">
            <TrackForm locale={locale} id="track-number" />
          </div>
          <p className="mt-3 text-xs text-[var(--kb-muted)]">{t(locale, 'trackHint')}</p>
          <p className="mt-4 border-t border-[var(--kb-border)] pt-4 text-xs text-[var(--kb-muted)]">
            {t(locale, 'trackPrivacyNote')}
          </p>
        </Panel>
      </PageBody>
    </>
  );
}

/**
 * The answer for one number.
 *
 * Its own component so the shell above renders identically whatever the lookup
 * says — the form a customer needs in order to fix a typo is on screen before
 * the database is asked, not conditionally afterwards.
 */
async function Lookup({ locale, canonical }: { locale: Locale; canonical: string }) {
  const ip = clientIpFrom(await headers());

  if (!allow(`track:${ip}`, LOOKUPS, LOOKUP_WINDOW_MS)) {
    return (
      <Panel className="p-6">
        <p className="text-[var(--kb-muted)]">{t(locale, 'trackThrottled')}</p>
      </Panel>
    );
  }

  /*
   * A read-through against the shipping platform, not a database read.
   *
   * `publicTrackingFor` refreshes a parcel this system already knows about and
   * reads an unknown number straight from the platform without storing anything
   * — see `lib/shipments/lookup.ts` for why an anonymous lookup is not allowed
   * to create a row. It never throws: a platform that is down leaves the stored
   * status, or the page's ordinary "no status yet".
   *
   * What comes back is deliberately not a `ShipmentDetail`. `PublicTracking`
   * carries a status, its instant and the event history and *structurally
   * cannot* carry a name, an address, a phone number or the COD amount — which
   * is what keeps the promise this page makes in `trackPrivacyNote` true by
   * construction rather than by review (`docs/PROJECT-STATE.md` §6.38).
   */
  /*
   * Alongside it, the Arabic wording an admin has chosen in `/admin/tracking`.
   * In parallel because the two have nothing to say to each other and the
   * platform call is allowed four seconds; `phraseOverrides` never throws, so a
   * wording that could not be read leaves the defaults rather than the page.
   */
  const [tracking, overrides] = await Promise.all([
    publicTrackingFor(canonical),
    phraseOverrides(),
  ]);

  /*
   * One object or none, rather than a shipment and a display beside it. Every
   * branch below asks the same question — do we have a status worth drawing? —
   * and folding the label, its timestamp and its stage into a single nullable
   * value is what makes that one check instead of three that can disagree.
   *
   * The label is read in the page's own language: `out_for_delivery` reaches an
   * English reader as `Out for delivery` and an Arabic one as `خرجت للتسليم`.
   * `statusLabel` carries why the Arabic page translates where the English one
   * only reformats, and why an unrecognised label is still shown verbatim in
   * both. `stageDisplay` reads the raw token either way, which is what the
   * vocabulary table's keywords are written for.
   */
  /*
   * Which journey this parcel is on, before anything is drawn.
   *
   * `rto_requested` rather than the status, because the platform leaves the
   * status reading `delivery_attempted` for the whole of a return — see
   * `returnProgress`. Null means the ordinary outbound case.
   */
  const returning = tracking
    ? returnProgress({
        rtoRequested: tracking.rtoRequested,
        status: tracking.status,
        events: tracking.events,
      })
    : null;

  const status = tracking
    ? {
        /*
         * On a return the badge says where the parcel is going, not where the
         * outbound leg stopped. Showing `delivery_attempted` — which is what the
         * platform still reports — would headline the page with the last thing
         * that failed rather than the thing that is now happening.
         *
         * The step's own wording rather than a translation of the latest return
         * event, because the two vocabularies disagree on tense at exactly the
         * moment it matters: `return_to_origin` reads as `مرتجعة إلى الراسل` —
         * *returned* — through the delivery table, above a bar whose first step
         * has only just lit. The step is what the bar is showing, so the badge
         * says the same thing.
         */
        label: returning
          ? returnStepLabel(locale, returning.step, overrides)
          : statusLabel(locale, tracking.status, overrides),
        at: returning?.at ?? tracking.statusAt,
        events: tracking.events,
        estimatedDate: tracking.estimatedDate,
        ...stageDisplay(tracking.status),
        // A returning parcel wears the returned tone whatever the stale status
        // says, and leaves the outbound line entirely.
        ...(returning ? { tone: 'returned' as const, step: null } : {}),
      }
    : null;

  /*
   * The articles are chosen by searching the knowledge base for the status as
   * this page just worded it — "out for delivery" finds the English articles
   * about what that means, and "خرجت للتسليم" the Arabic ones. Searching on the
   * platform's English token in both languages is what this used to do, and it
   * asked an Arabic knowledge base an English question: the column that is meant
   * to catch a customer at their worst moment came back empty for the half of
   * readers most likely to need it. A hand-written article list per status would
   * be a second place to maintain every time the knowledge base is edited, and
   * it would go stale silently, in the direction nobody notices.
   *
   * When there is no status to search on, or the search found nothing, the
   * most-read articles stand in under their own heading rather than under
   * "answers for this status". This is the page's dead end — a customer who has
   * just been told we cannot say where their parcel is — and the worst thing to
   * put in front of them is an empty column.
   */
  const viewer = await kbViewer();
  const matched = status ? await searchArticles(viewer, locale, status.label, 4) : [];
  const answers =
    matched.length > 0
      ? { title: t(locale, 'trackAnswers'), articles: matched }
      : { title: t(locale, 'mostRead'), articles: await popularArticles(viewer, locale, 4) };

  const subject = `${t(locale, 'trackTitle')}: ${canonical}`;

  /*
   * The chat's opening draft, built here because this is where the status has
   * already been worded — the message says what the badge says, in the language
   * the page is being read in, and cannot say more.
   */
  const prefill = shipmentChatPrefill({
    locale,
    trackingNumber: canonical,
    statusLabel: status?.label ?? null,
  });

  return (
    <>
      <Panel className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge
            label={status ? status.label : t(locale, 'trackNoStatusTitle')}
            tone={status ? status.tone : 'unknown'}
          />
          <span
            dir="ltr"
            className="text-sm tabular-nums text-[var(--kb-muted)]"
            aria-label={t(locale, 'trackNumber')}
          >
            {canonical}
          </span>
        </div>

        {status === null ? (
          <p className="mt-4 text-[var(--kb-muted)]">{t(locale, 'trackNoStatus')}</p>
        ) : null}

        {/*
          One bar or the other, never both, and never the outbound one during a
          return: its last step is "Delivered", which is the single thing that is
          not going to happen. The return bar is drawn in the `returned` tone so
          the two do not read as one journey continuing.
        */}
        {status !== null && returning !== null ? (
          <div className="mt-6">
            <p className="mb-4 text-[var(--kb-heading)]">{t(locale, 'trackReturning')}</p>
            <Stepper
              tone="returning"
              current={returning.step}
              labels={RETURN_STEPS.map((_, index) => returnStepLabel(locale, index, overrides))}
            />
          </div>
        ) : null}

        {status !== null && returning === null && status.step !== null ? (
          <div className="mt-6">
            <Stepper current={status.step} labels={deliveryStepLabels(locale)} />
          </div>
        ) : null}

        {/*
          The estimated date, and only while it is still a prediction. Printing
          "estimated delivery: Saturday" under a parcel that was delivered on
          Sunday reads as a correction nobody asked for, and under a returned one
          it is simply false — `terminal` is the same flag the stepper uses to
          decide the journey is over.
        */}
        {status !== null && status.estimatedDate && !status.terminal && returning === null ? (
          <p className="mt-5 text-sm text-[var(--kb-muted)]">
            {t(locale, 'trackEstimated')}:{' '}
            <span className="font-medium text-[var(--kb-heading)]">
              {formatCalendarDate(locale, status.estimatedDate)}
            </span>
          </p>
        ) : null}

        {/*
          One or the other, never both. The timeline's first row is the last
          update and carries its own time, so showing `LastUpdate` above it would
          print the same instant twice under two headings.
        */}
        {status !== null && status.events.length === 0 ? (
          <div className="mt-6">
            <LastUpdate
              locale={locale}
              when={
                status.at ? (
                  <time dateTime={status.at.toISOString()}>
                    {formatTimestamp(locale, status.at)}
                  </time>
                ) : (
                  t(locale, 'trackNoTimestamp')
                )
              }
            />
          </div>
        ) : null}

        {status !== null && status.events.length > 0 ? (
          <div className="mt-6 border-t border-[var(--kb-border)] pt-5">
            <Timeline
              locale={locale}
              events={status.events}
              overrides={overrides}
              returnFrom={returning?.startedAt ?? null}
            />
          </div>
        ) : null}

        {/*
          Every route carries the number: it is what an agent needs first, and it
          is what `lib/shipments/detect.ts` reads — so a ticket raised from this
          page links itself to the shipment the customer was looking at without
          anybody typing the number a second time. The chat carries it in the
          draft, the mailbox in the subject line.

          Support is the chat, and that is the change this button needed. It used
          to lead to `/forms`, which redirects to `/portal/new` where no form has
          been built — and that asks for an account. A recipient who has never
          signed in to ShipBlu is most of the people who reach this page, so the
          one action the page exists for answered them with a sign-in wall. The
          chat needs no account: `talkToAgent` mints a visitor token at the
          moment somebody chooses to talk. The `/forms` link is still the `href`,
          because it is where this goes with no JavaScript, and it is the right
          destination once an admin has built a form.

          The email link stays for the visitor the widget cannot serve — a
          blocked snippet, or somebody who would rather have a copy of what they
          sent.
        */}
        <div className="mt-6 border-t border-[var(--kb-border)] pt-5">
          <div className="flex flex-wrap gap-3">
            <AskSupport
              href={`/${locale}/forms?subject=${encodeURIComponent(subject)}`}
              prefill={prefill}
              className="rounded-md bg-[var(--button-primary)] px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
            >
              {t(locale, 'trackAskSupport')}
            </AskSupport>
            <a
              href={`mailto:support@shipblu.com?subject=${encodeURIComponent(subject)}`}
              className="rounded-md border border-[var(--kb-border-strong)] px-3.5 py-2 text-sm font-semibold text-[var(--kb-heading)] transition-colors hover:bg-[var(--kb-surface-2)]"
            >
              {t(locale, 'email')}
            </a>
          </div>
          {/* Said before the click rather than after it: a button that opens a
              panel in the corner instead of a page is worth one line of warning,
              and it is also the line that promises the number travels with it. */}
          <p className="mt-3 text-xs text-[var(--kb-muted)]">{t(locale, 'trackAskSupportHint')}</p>
        </div>
      </Panel>

      <Answers locale={locale} title={answers.title} articles={answers.articles} />
    </>
  );
}

/** Articles under a heading, or nothing at all when there are none to list. */
function Answers({
  locale,
  title,
  articles,
}: {
  locale: Locale;
  title: string;
  articles: { id: string; title: string; slug: string; excerpt?: string | null }[];
}) {
  if (articles.length === 0) return null;

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-[var(--kb-heading)]">{title}</h2>
      <ArticleList>
        {articles.map((article) => (
          <ArticleRow
            key={article.id}
            href={`/${locale}/a/${article.slug}`}
            title={article.title}
            excerpt={article.excerpt}
          />
        ))}
      </ArticleList>
    </section>
  );
}
