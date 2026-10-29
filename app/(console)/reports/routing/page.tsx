import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Stat } from '@/components/charts';
import { buttonClass, EmptyState, Notice, PageHeader } from '@/components/ui';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import type { CategoryAiMode } from '@/lib/category-ai/modes';
import { readCategoryAiSettings } from '@/lib/category-ai/settings';
import { allLimited } from '@/lib/concurrency';
import { formatDateTime } from '@/lib/format';
import { dateIn, rangeIn, reportingZone, type ReportWindow } from '@/lib/reports/rollup';
import { routingStartFor, type RoutingMode } from '@/lib/routing/mode';
import {
  idleClassifierSentence,
  noKeyRoutingSentence,
  ROUTING_MODE_LABELS,
  ROUTING_OUTCOME_LABELS,
} from '@/lib/routing/mode-copy';
import {
  decisionTiming,
  fallbackReasons,
  GRACE_IN_WORDS,
  minutesInWords,
  routedStillUnassigned,
  routerDecided,
  routingChannels,
  routingHistory,
  routingOutcomes,
  shadowAgainstPeople,
  STILL_UNASSIGNED_IN_WORDS,
  strandedRouting,
  sumOutcomes,
  takenTickets,
  type RoutingChannel,
} from '@/lib/routing/report';
import { typesafeConfigured } from '@/lib/typesafe/client';
import { RangeNav } from '../range-nav';
import { Quiet, rate, Section } from '../report-parts';
import {
  FallbackTable,
  OutcomeTable,
  ShadowTable,
  TicketLink,
  TicketLinks,
  TimingTable,
  UnassignedTable,
} from './parts';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/** The modes that start routing, in the channel form's order. */
const ROUTING: readonly RoutingMode[] = ['category', 'category_shadow'];

const CLASSIFIER_STATES: Record<CategoryAiMode, string> = {
  off: 'switched off',
  shadow: 'in Shadow, filing nothing',
  apply: 'in Apply, filing tickets',
};

/**
 * Where each channel's new tickets went once they routed by category, how
 * long deciding took against the window, and what is still open from it
 * (`plans/ticket-category-routing.md`, Stage 6) — the readiness panel on
 * `/admin/channels` says what will happen, this says what did.
 *
 * Behind `report.view`, like every team report: its figures are per channel
 * and per group, about the queue rather than about named people, and the
 * tickets it lists open through the inbox, which applies the reader's own
 * visibility.
 *
 * Range-bound figures are filed on the day a ticket entered routing in the
 * reporting zone (`reportingZone()`, the default business hours' zone).
 * The two sections under Now are not: a ticket left unassigned after routing for
 * sixty days, or a record that never closed, matters most and would fall out
 * of a thirty-day window.
 */
export default async function RoutingReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const agent = await requireAgent();
  if (!can(agent, 'report.view')) notFound();

  const { days: requested } = await searchParams;
  const days = RANGES.includes(Number(requested) as (typeof RANGES)[number])
    ? Number(requested)
    : 30;

  // One window and one instant for every read and for the dates printed above
  // them (`lib/routing/report.ts`).
  const zone = await reportingZone();
  const window: ReportWindow = { ...rangeIn(zone, days), zone };
  const now = new Date();

  // The state first: a table that has never held a row needs nothing else,
  // and it is what the page reads until routing is switched on anywhere.
  const [history, channelList, settings] = await allLimited(2, [
    () => routingHistory(now),
    () => routingChannels(),
    () => readCategoryAiSettings(),
  ]);
  const keyConfigured = typesafeConfigured();
  const modes = new Map(channelList.map((channel) => [channel.id, channel]));
  const routingNow = channelList.filter(
    (channel) => channel.isActive && ROUTING.includes(channel.mode),
  );

  const header = (
    <PageHeader
      title="Routing"
      description={`${window.from} to ${window.to}, in ${zone}. Where each channel’s new tickets went once they routed by category, and what is still open from it.`}
      actions={
        <>
          <RangeNav
            ranges={RANGES}
            current={days}
            href={(each) => `/reports/routing?days=${each}`}
          />
          {can(agent, 'admin.channels') ? (
            <Link
              href="/admin/channels"
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Channels
            </Link>
          ) : null}
          {can(agent, 'admin.categories') ? (
            <Link
              href="/admin/categories"
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Categories
            </Link>
          ) : null}
          <Link
            href={`/reports?days=${days}`}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            All reports
          </Link>
        </>
      }
    />
  );
  const state = (
    <StateNotice
      classifier={settings.mode}
      windowMinutes={settings.routingWindowMinutes}
      keyConfigured={keyConfigured}
      routingNow={routingNow}
    />
  );

  if (history.first === null) {
    return (
      <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
        {header}
        <div className="mb-6 max-w-3xl">{state}</div>
        <EmptyState
          title="Nothing has entered routing yet"
          hint={neverRoutedHint(settings.mode, routingNow)}
        />
      </div>
    );
  }

  const [slices, timing, reasons, taken, unassigned, stranded, shadow] = await allLimited(2, [
    () => routingOutcomes(window, now),
    () => decisionTiming(window, now),
    () => fallbackReasons(window, now),
    () => takenTickets(window, now),
    () => routedStillUnassigned(now),
    () => strandedRouting(now),
    () => shadowAgainstPeople(window, now),
  ]);

  const live = slices.filter((slice) => !slice.shadow);
  const shadowSlices = slices.filter((slice) => slice.shadow);
  const liveTotals = sumOutcomes(live.map((slice) => slice.outcomes));
  const router = routerDecided(liveTotals);
  const waiting = unassigned.filter((row) => row.strategy !== 'manual');
  const waitingCount = waiting.reduce((total, row) => total + row.tickets, 0);
  const byDesign = unassigned.reduce((total, row) => total + row.tickets, 0) - waitingCount;
  const windowsInForce = [...new Set(timing.flatMap((row) => row.windowMinutes))].sort(
    (a, b) => a - b,
  );
  const shadowDecided = shadow.some(
    (row) => row.wouldMove + row.wouldKeep + row.manual + row.rule > 0,
  );
  const firstDay = dateIn(history.first, zone);
  // The history starting inside the window is what makes the range buttons
  // look broken: every wider window answers the same (§6.54).
  const startsLate = firstDay > window.from;
  const idle = (mode: RoutingMode) =>
    routingNow.filter(
      (channel) =>
        channel.mode === mode &&
        !slices.some(
          (slice) => slice.channelId === channel.id && slice.shadow === (mode !== 'category'),
        ),
    );

  return (
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      {header}

      <div className="mb-6 max-w-3xl space-y-2">
        {state}
        {stranded.live + stranded.shadow > 0 ? (
          <Notice tone="warning" icon>
            {strandedSentence(stranded.live, stranded.shadow)} Each is listed under Now, and{' '}
            <code>npm run job -- settle_routing conversationId=…</code>, run from the worker&rsquo;s
            shell, decides one as the end of its window would have.
          </Notice>
        ) : null}
        {startsLate ? (
          <Notice tone="info" icon>
            This window opens on {window.from}, but the first ticket entered routing on{' '}
            <b>{firstDay}</b>. A wider range cannot reach further back than that.
          </Notice>
        ) : null}
        {windowsInForce.length > 1 ? (
          <Notice tone="warning" icon>
            The routing window changed during this range: tickets entered with windows of{' '}
            {inWords(windowsInForce)} minutes. A percentile over both answers neither, so read the
            times below on a range that starts after the change.
          </Notice>
        ) : null}
      </div>

      {slices.length === 0 ? (
        <div className="mb-8">
          <Quiet>
            No ticket entered routing between {window.from} and {window.to}. The last one entered on{' '}
            {dateIn(history.last ?? history.first, zone)}.
          </Quiet>
        </div>
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Routed"
              value={rate(liveTotals.category, router)}
              hint={ofRouter(liveTotals.category, router)}
              explain={
                <>
                  Live tickets the router moved to the group their category routes to, out of the
                  decisions it made itself. Holds a person or a rule ended first are not in it: the
                  router never decided those.
                </>
              }
            />
            <Stat
              label="Window ran out"
              value={rate(liveTotals.fallback, router)}
              hint={ofRouter(liveTotals.fallback, router)}
              explain={
                <>
                  Nothing had filed the ticket by the end of its window, so it stayed in its
                  channel&rsquo;s default group. Why each ran out is under Why the window ran out.
                </>
              }
            />
            <Stat
              label="Already taken"
              value={liveTotals.taken.toLocaleString()}
              tone={liveTotals.taken > 0 ? 'caution' : undefined}
              hint="Should be near 0: each one is listed below"
              explain={
                <>
                  Live tickets somebody already held when the router decided, so it never moved
                  them: assigned without ending the hold, by the sweep after the grace or a stuck
                  worker.
                </>
              }
            />
            <Stat
              label="Unassigned after routing"
              value={waitingCount.toLocaleString()}
              tone={waitingCount > 0 ? 'caution' : undefined}
              hint={
                byDesign > 0
                  ? `As of when this page loaded · and ${byDesign} in manual groups`
                  : 'As of when this page loaded'
              }
              explain={
                <>
                  Live tickets that entered routing, of any range, still open and never assigned
                  since, {STILL_UNASSIGNED_IN_WORDS} after their hold ended: long enough for the
                  assignment as the hold ends and the sweeps behind it. Every decision counts but
                  &ldquo;{ROUTING_OUTCOME_LABELS.not_open}&rdquo;, since the router assigns nobody a
                  ticket that was no longer open when it decided. Tickets in a group set to manual
                  wait for somebody to pick them, by design, and are counted apart.
                </>
              }
            />
          </section>

          {live.length > 0 || idle('category').length > 0 ? (
            <Section
              title="By channel — live"
              hint="Every ticket that entered routing on a channel set to By category, by the channel row it arrived on: where each stands, with three shares of what was decided, and then the decisions counted by outcome."
            >
              <OutcomeTable
                slices={live}
                shadow={false}
                idleChannels={idle('category')}
                modes={modes}
              />
            </Section>
          ) : null}

          {shadowSlices.length > 0 || idle('category_shadow').length > 0 ? (
            <Section
              title="By channel — shadow"
              hint="Tickets on a channel set to By category — shadow: nothing was held, and each outcome is where the ticket would have gone. A shadow ticket is never already taken — the rota assigns it on arrival — so that column is empty."
            >
              <OutcomeTable
                slices={shadowSlices}
                shadow
                idleChannels={idle('category_shadow')}
                modes={modes}
              />
            </Section>
          ) : null}

          {timing.length > 0 ? (
            <Section
              title="Time to decision"
              hint="How long after a ticket entered routing its category settled and the router decided, against the window it was given. A ticket whose window ran out was decided at the window's end by definition, so it is measured by how late the settle job got there."
            >
              <TimingTable rows={timing} />
            </Section>
          ) : null}

          {reasons.length > 0 ? (
            <Section
              title="Why the window ran out"
              hint="For each ticket whose window ran out: whether a category arrived afterwards, which says the window was too short, and what Jev had answered by then, which says whether the threshold was."
            >
              <FallbackTable rows={reasons} />
            </Section>
          ) : null}

          {shadowDecided ? (
            <Section
              title="Shadow — would-be against what people did"
              hint="Each shadow decision against the last change of group a person made after it. Where people moved a ticket the router would have moved it too, routing would have saved the move; where they moved one the router would have kept, a route is missing."
            >
              <ShadowTable rows={shadow} />
            </Section>
          ) : null}

          {live.length > 0 ? (
            <Section
              title="Already taken"
              hint="Live tickets somebody held when the router decided. Each is worth reading: something assigned the ticket without ending its hold."
            >
              {taken.total === 0 ? (
                <Quiet>
                  No live ticket in this window was already taken when the router decided.
                </Quiet>
              ) : (
                <TicketLinks tickets={taken.tickets} total={taken.total} />
              )}
            </Section>
          ) : null}
        </>
      )}

      <h2 className="mb-1 text-base font-semibold">Now</h2>
      <p className="mb-4 max-w-3xl text-xs text-(--color-text-tertiary)">
        As of when this page loaded, {formatDateTime(now, zone)}, whatever the range above.
      </p>

      <Section
        title="Still unassigned after routing"
        hint={`Live tickets that entered routing, whatever was decided but “${ROUTING_OUTCOME_LABELS.not_open}”, that nobody has been assigned since, ${STILL_UNASSIGNED_IN_WORDS} after their hold ended, by the group each is in now — a rule may have moved it since — and the decision that put it there.`}
      >
        {unassigned.length === 0 ? (
          <Quiet>
            Every live ticket that entered routing and is still open has had somebody assigned
            since, its hold ended less than {STILL_UNASSIGNED_IN_WORDS} ago, or it was no longer
            open when the router decided.
          </Quiet>
        ) : (
          <UnassignedTable rows={unassigned} />
        )}
      </Section>

      <Section
        title="Stranded"
        hint={`Routing records nothing decided by ${GRACE_IN_WORDS} after their window ended. A live one is no longer held, so the sweep may already have assigned it: what is left open is the record, and what its decision owed.`}
      >
        {stranded.rows.length === 0 ? (
          <Quiet>Nothing stranded: every routing record was decided in time.</Quiet>
        ) : (
          <ul className="space-y-1 text-sm">
            {stranded.rows.map((row) => (
              <li key={row.conversationId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <TicketLink ticket={row} />
                {/* Inline, not `ChannelName`: its flex box broke this one
                    sentence over three lines. */}
                <span className="text-xs text-(--color-text-secondary)">
                  {row.shadow ? 'Shadow' : 'Live'} ·{' '}
                  {row.channelName === null ? (
                    'a deleted channel'
                  ) : (
                    <span dir="auto">{row.channelName}</span>
                  )}{' '}
                  · window ended {formatDateTime(row.windowEndsAt, zone)}
                </span>
                <code className="text-xs break-all">conversationId={row.conversationId}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="max-w-3xl text-xs text-(--color-text-tertiary)">
        {`While the category classifier is in Apply, a ticket enters routing when it arrives on a channel set to “${ROUTING_MODE_LABELS.category}” or “${ROUTING_MODE_LABELS.category_shadow}”, unless another row of that kind files its tickets or the number’s owner is given it as it arrives; a continuation, a reopen or a ticket opened by an agent never does.`}{' '}
        A ticket deleted for good leaves every figure here, since its record goes with it. A
        decision a person or a rule made first carries no category, so what the router decided on is
        known only for its own outcomes. Times are measured to when the decision was recorded.
      </p>
    </div>
  );
}

/**
 * The tile's line under a share of the router's own decisions. Under ten
 * decisions `rate` already prints the share as "n of d", and the same words
 * again below it read as a stutter, so the line then says what d counts.
 */
function ofRouter(count: number, router: number): string {
  return rate(count, router).endsWith('%')
    ? `${count} of ${router} the router decided, live`
    : 'Of the decisions the router made itself, live';
}

/** "5 and 10", "5, 10 and 15": the window lengths as a sentence says them. */
function inWords(values: number[]): string {
  return values.length < 2
    ? values.join('')
    : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function strandedSentence(live: number, shadow: number): string {
  const parts = [live > 0 ? `${live} live` : null, shadow > 0 ? `${shadow} shadow` : null].filter(
    Boolean,
  );
  const total = live + shadow;
  return `${parts.join(' and ')} routing ${total === 1 ? 'record is' : 'records are'} still undecided more than ${GRACE_IN_WORDS} after ${total === 1 ? 'its window' : 'their windows'} ended, long after the job that decides each was due.`;
}

/**
 * The classifier's state and which channels route, said before any figure:
 * every channel's mode through `routingModeOf`, so a coexistence number or the
 * bot whose column says otherwise is not reported as routing.
 */
function StateNotice({
  classifier,
  windowMinutes,
  keyConfigured,
  routingNow,
}: {
  classifier: CategoryAiMode;
  windowMinutes: number;
  keyConfigured: boolean;
  routingNow: RoutingChannel[];
}) {
  // Asked as ingest asks it, row by row: whether its tickets reach the
  // question of its mode at all (`files` — no other row files for it, no
  // active owner is stamped on them, as the readiness panel says), then
  // `routingStartFor`, where only a live start holds, so a shadow row holds
  // nothing, and with the classifier off or in shadow nothing enters routing.
  // The rows are named rather than "a channel set to By category": said of
  // the mode, the sentence told an admin in the shadow week that tickets were
  // being kept back, and with one row holding it spoke for an owned number
  // beside it too, which the panel says never holds.
  const holding = routingNow.filter(
    (channel) => channel.files && routingStartFor(channel.mode, classifier) === 'live',
  );
  const filing = routingNow.filter((channel) => channel.files);
  const inert = routingNow.filter((channel) => !channel.files);
  return (
    <>
      <Notice tone="neutral">
        {/* With no key Apply is a setting, not what Jev does: "filing
            tickets" sat over the warning below that it is asked nothing. */}
        The category classifier is{' '}
        <b className="text-(--color-text-primary)">
          {classifier === 'apply' && !keyConfigured
            ? 'set to Apply'
            : CLASSIFIER_STATES[classifier]}
        </b>
        {holding.length > 0 ? (
          <>
            , and a new ticket on <ChannelNames channels={holding} last="or" /> is held for{' '}
            {minutesInWords(windowMinutes * 60_000)}.{' '}
          </>
        ) : (
          <>, and no new ticket is held. </>
        )}
        {routingNow.length === 0 ? (
          <>Every active channel starts its tickets in its default group.</>
        ) : (
          <>
            {filing.length > 0 ? (
              <>
                Routing by category now: <ChannelNames channels={filing} modes />.{' '}
              </>
            ) : null}
            {inert.length > 0 ? (
              <>
                Set to route, though no ticket can enter routing there:{' '}
                <ChannelNames channels={inert} modes />. Another row of the same kind files its
                tickets, or its number’s owner is given them as they arrive; Settings → Channels
                says which.{' '}
              </>
            ) : null}
            Every other active channel starts its tickets in its default group.
          </>
        )}
      </Notice>
      {/* The readiness panel's two sentences, said where they are true: only
          over a row whose tickets would reach routing, as the panel asks it. */}
      {classifier !== 'apply' && filing.length > 0 ? (
        <Notice tone="warning" icon>
          {idleClassifierSentence(classifier)}
        </Notice>
      ) : null}
      {classifier === 'apply' && !keyConfigured && filing.length > 0 ? (
        <Notice tone="warning" icon>
          {noKeyRoutingSentence(windowMinutes)}
        </Notice>
      ) : null}
    </>
  );
}

/** Channel names in bold, joined as a sentence would join them, each with its mode when asked. */
function ChannelNames({
  channels,
  modes = false,
  last = 'and',
}: {
  channels: RoutingChannel[];
  modes?: boolean;
  last?: 'and' | 'or';
}) {
  return channels.map((channel, index) => (
    <span key={channel.id}>
      {index === 0 ? '' : index === channels.length - 1 ? ` ${last} ` : ', '}
      <b className="text-(--color-text-primary)" dir="auto">
        {channel.name}
      </b>
      {modes ? ` (${ROUTING_MODE_LABELS[channel.mode]})` : null}
    </span>
  ));
}

/**
 * Which of the two things a ticket needs to enter routing is missing, in the
 * forms' words — and, when both are set, whether any channel set to route can
 * hold a ticket at all (`files`), which only the readiness panel can explain.
 */
function neverRoutedHint(classifier: CategoryAiMode, routingNow: RoutingChannel[]): string {
  const rule = `A ticket enters routing when it arrives on a channel set to “${ROUTING_MODE_LABELS.category}” or “${ROUTING_MODE_LABELS.category_shadow}” under Settings → Channels, while the category classifier is in Apply under Settings → Categories.`;
  const missing = [
    classifier === 'apply' ? null : `The classifier is ${CLASSIFIER_STATES[classifier]}.`,
    routingNow.length === 0
      ? `Every active channel is on ${ROUTING_MODE_LABELS.default_group}.`
      : null,
  ].filter(Boolean);
  if (missing.length > 0) return `${rule} ${missing.join(' ')}`;
  const entering = routingNow.filter((channel) => channel.files);
  if (entering.length === 0) {
    return `${rule} Both are set, but no ticket on ${routingNow.map((channel) => channel.name).join(', ')} can enter it: another row of its kind files its tickets, or its number’s owner is given them as they arrive. Settings → Channels says which.`;
  }
  return `${rule} Both are set, so the next new ticket on ${entering.map((channel) => channel.name).join(', ')} enters routing.`;
}
