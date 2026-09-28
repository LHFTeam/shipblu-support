import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Meter, Stat } from '@/components/charts';
import { Badge, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { areaLabel } from '@/lib/categorise/taxonomy';
import { channelLabel } from '@/lib/format';
import { ChannelBadge } from '@/components/channel';
import {
  areaTotals,
  categoryTotals,
  causeCoverage,
  causeTotals,
  channelTotals,
  ownerTotals,
  rolledUpRange,
} from '@/lib/reports/category-queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * What customers contacted us about, and why it happened.
 *
 * Two halves, and the second is the point. Volume by category says what the
 * queue was full of; volume by cause and owner says what to go and change. A
 * support team can read the first every week and never learn anything from it;
 * the second is the one that ends an argument about whose problem something is.
 *
 * Reads only the nightly rollup, exactly as `/reports` does, so today's numbers
 * appear tomorrow rather than making every open tab run an aggregate over the
 * whole archive. The one live read is the cause coverage, and that is deliberate
 * — see `causeCoverage`.
 *
 * ## Why the range control says so much
 *
 * It was reported as broken, and from the outside it was indistinguishable from
 * broken: `rollup_metrics` recomputes three days a night and there is no
 * category backfill, so any window wider than the history holds the same rows —
 * 7, 30 and 90 answered identically and the buttons looked dead. Two things fix
 * that, and neither is the numbers. The header prints the window it selected, so
 * a press always changes something visible; and `rolledUpRange` says how much of
 * that window has figures at all, so "these three are the same" reads as a fact
 * about the archive rather than a fault in the page.
 *
 * The window itself comes from `rangeIn()` in the reporting zone rather than
 * from the database's `current_date`, which is UTC — the rollup buckets days in
 * the team's zone, so the two disagreed about which day it was for the first two
 * hours of every Cairo morning.
 */
export default async function CategoryReportPage({
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

  // The team's zone, so the window's edges land on the team's midnights — the
  // same context the nightly rollup bucketed these rows by.
  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);

  const [categories, areas, channels, causes, owners, coverage, rolledUp] = await Promise.all([
    categoryTotals(range),
    areaTotals(range),
    channelTotals(range),
    causeTotals(range),
    ownerTotals(range),
    causeCoverage(range, zone),
    rolledUpRange(range),
  ]);

  const areaTickets = areas.reduce((sum, area) => sum + area.ticketsPrimary, 0);
  const ownerTotal = owners.reduce((sum, owner) => sum + owner.ticketsResolved, 0);
  const unread = channels.reduce((sum, channel) => sum + channel.unread, 0);
  const missing = coverage.total - coverage.withCause;
  const covered =
    coverage.total > 0 ? Math.round((100 * coverage.withCause) / coverage.total) : null;

  /*
   * Whether the history stops short of the window, which is the whole answer to
   * "the range buttons do nothing".
   *
   * Keyed on where the figures *start* rather than on how many days inside the
   * window carry rows. Two things make a day legitimately empty — today, which
   * the rollup clamps off because it is not complete, and any day the team took
   * no categorised tickets — so a day count short of `days` is the normal state
   * and a warning drawn from it would be permanent furniture. A first day later
   * than the window's start is the real signal: it means a wider range cannot
   * reach further back, so the three buttons must agree with each other. `first`
   * is where the history starts even when that is before the window — a quiet
   * opening day has no row — which `rolledUpRange` explains.
   */
  const startsLate = rolledUp.first !== null && rolledUp.first > range.from;

  const leadArea = areas.find((area) => area.ticketsPrimary > 0) ?? null;

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="What tickets are about"
        description={`${range.from} to ${range.to}, in ${zone}. Demand by category, and — the half that matters — why those tickets existed and who owns fixing it.`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <nav className="flex gap-1 text-sm">
              {RANGES.map((each) => (
                <Link
                  key={each}
                  href={`/reports/categories?days=${each}`}
                  aria-current={each === days ? 'page' : undefined}
                  className={`rounded-md px-2.5 py-1 ${
                    each === days ? 'bg-[var(--muted)] font-medium' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  {each} days
                </Link>
              ))}
            </nav>
            <Link
              href={`/reports?days=${days}`}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
            >
              All reports
            </Link>
          </div>
        }
      />

      {categories.length === 0 && causes.length === 0 ? (
        <EmptyState
          title="Nothing rolled up yet"
          hint={`No category or cause has been counted between ${range.from} and ${range.to}. These figures come from the nightly rollup, so a category assigned today appears tomorrow — run \`npm run job -- rollup_metrics\` to build them now.`}
        />
      ) : (
        <>
          {/*
            Two sentences that have to be read before any number below, kept in
            one block so neither can be scrolled past on its own.

            The first is the multi-label warning: a ticket routinely carries two
            or three categories, so the column does not sum to the ticket count,
            and without saying so the first person to add it up files a bug. The
            second only appears when the history starts inside the window, which
            is the state that makes the range control look broken.
          */}
          <div className="mb-6 max-w-2xl space-y-2">
            <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--muted-foreground)]">
              A ticket can be about more than one thing, so{' '}
              <b className="text-[var(--foreground)]">Mentioned</b> counts every ticket carrying a
              category and does not add up to the number of tickets.{' '}
              <b className="text-[var(--foreground)]">Leading</b> counts each ticket once, under
              whichever category leads it — that is the column to compare against a ticket count.
            </p>

            {startsLate ? (
              <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                This window opens on {range.from}, but the categorised history{' '}
                <b>begins on {rolledUp.first}</b> — {rolledUp.days}{' '}
                {rolledUp.days === 1 ? 'day' : 'days'} of it in this window. Categorisation records
                forward only and there is no backfill, so a wider range cannot reach further back
                than that: until more history accumulates, 7, 30 and 90 days will keep answering the
                same.
              </p>
            ) : null}
          </div>

          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Tickets categorised"
              value={areaTickets.toLocaleString()}
              hint="Counted once each, under the category leading them"
              explain={
                <>
                  A ticket is counted on the day it <em>arrived</em>, because a category describes
                  demand. The causes further down are counted on the day somebody worked them out
                  instead, so the two halves of this page deliberately do not describe the same set
                  of tickets.
                </>
              }
            />
            <Stat
              label="Biggest area"
              value={leadArea ? areaLabel(leadArea.area) : '—'}
              hint={
                leadArea && areaTickets > 0
                  ? `${Math.round((100 * leadArea.ticketsPrimary) / areaTickets)}% of tickets`
                  : 'Nothing leads yet'
              }
            />
            <Stat
              label="Nothing matched"
              value={unread.toLocaleString()}
              tone={unread > 0 ? 'caution' : undefined}
              hint="Tickets with a message no rule could read"
              explain={
                <>
                  Under-detection, which is the cheap failure: it shows up here rather than moving a
                  number somebody staffs a team from. It is counted per message, so a ticket whose
                  first message matched a rule and whose second did not appears both here and under
                  its category — which is why this is a count and never a percentage.
                </>
              }
            />
            <Stat
              label="Cause recorded"
              value={covered === null ? '—' : `${covered}%`}
              tone={covered !== null && covered < 50 ? 'critical' : undefined}
              hint={
                coverage.total > 0
                  ? `${coverage.withCause.toLocaleString()} of ${coverage.total.toLocaleString()} that owed one`
                  : 'No ticket in this window owed one'
              }
              explain={
                <>
                  Only tickets about a delivery, a parcel&rsquo;s condition, a pickup, a return or a
                  payment owe a cause — those are the ones the resolve gate demands one for. A
                  price-list question never owes one, and counting it here would report a permanent
                  gap made of tickets that were never going to close it.
                </>
              }
            />
          </section>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-medium text-[var(--muted-foreground)]">By area</h2>
            {areas.length === 0 ? (
              <Quiet>No category was assigned in this window.</Quiet>
            ) : (
              <Table head={['Area', 'Tickets', 'Mentioned', 'Share of tickets']}>
                {areas.map((area) => (
                  <Row key={area.area}>
                    <Cell className="font-medium">{areaLabel(area.area)}</Cell>
                    <Cell>{area.ticketsPrimary.toLocaleString()}</Cell>
                    <Cell className="text-[var(--muted-foreground)]">
                      {area.ticketsAny.toLocaleString()}
                    </Cell>
                    <Cell>
                      <Share
                        value={area.ticketsPrimary}
                        of={areaTickets}
                        label={`${areaLabel(area.area)} share of tickets`}
                      />
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}

            {/*
              The share is of *tickets*, not of mentions, which is why the
              unclassified area reads 0% while carrying mentions: the fallback is
              never promoted to primary, because an admission that we could not
              read a ticket is not a finding. Said here rather than left for
              somebody to work out from two columns that disagree.
            */}
            {unread > 0 ? (
              <p className="mt-2 max-w-2xl text-xs text-[var(--muted-foreground)]">
                Unclassified shows a share of 0% by design — it is never the category leading a
                ticket, so it is a measurement gap rather than a slice of demand.
                {can(agent, 'admin.categories') ? (
                  <>
                    {' '}
                    The messages behind it are in{' '}
                    <Link href="/admin/categories/review" className="underline">
                      category review
                    </Link>
                    , which is where the next rule comes from.
                  </>
                ) : null}
              </p>
            ) : null}
          </section>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-medium text-[var(--muted-foreground)]">By category</h2>
            {categories.length === 0 ? (
              <Quiet>No category was assigned in this window.</Quiet>
            ) : (
              <Table
                head={[
                  'Category',
                  'Leading',
                  'Mentioned',
                  <>
                    How it was filed{' '}
                    <InfoTip label="How it was filed">
                      <b>Auto</b> means the rules were confident enough to apply it without asking.
                      <b> Suggested</b> means a rule proposed it and a person was asked — including
                      the ones already confirmed, because how a category was <em>filed</em> does not
                      change when somebody agrees with it, and counting confirmations here would
                      make last week&rsquo;s figures move every time the queue is worked through.{' '}
                      <b>By hand</b> is an agent filing something the rules missed — and a category
                      arriving by hand far more often than by rule is the clearest sign the lexicon
                      has a gap.
                    </InfoTip>
                  </>,
                ]}
              >
                {categories.map((category) => (
                  <Row key={category.categoryKey}>
                    <Cell>
                      <span className="font-medium">{category.label}</span>
                      <p className="text-xs text-[var(--muted-foreground)]">
                        {category.categoryKey}
                      </p>
                    </Cell>
                    <Cell>{category.ticketsPrimary.toLocaleString()}</Cell>
                    <Cell className="text-[var(--muted-foreground)]">
                      {category.ticketsAny.toLocaleString()}
                    </Cell>
                    <Cell className="text-xs whitespace-nowrap text-[var(--muted-foreground)]">
                      {category.assignedAuto} auto · {category.assignedSuggested} suggested ·{' '}
                      {category.assignedManual > 0 ? (
                        <b>{category.assignedManual} by hand</b>
                      ) : (
                        '0 by hand'
                      )}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
          </section>

          {/*
            The channel cut, which the rollup has always stored and this page
            never read. A lexicon can be good on email and useless on Instagram,
            and summed across channels that reads as a mediocre overall figure
            rather than as one channel nobody has written a rule for.
          */}
          <section className="mb-10">
            <h2 className="mb-2 text-sm font-medium text-[var(--muted-foreground)]">
              Where it arrived
            </h2>
            {channels.length === 0 ? (
              <Quiet>No category was assigned in this window.</Quiet>
            ) : (
              <Table
                head={[
                  'Channel',
                  'Tickets',
                  'Share of tickets',
                  <>
                    Nothing matched{' '}
                    <InfoTip label="Nothing matched">
                      Tickets carrying at least one message no rule could read. Deliberately not
                      shown as a percentage of the column beside it: that one counts tickets and
                      this one counts tickets-with-an-unread-message, so a ratio of the two would be
                      neither a share of tickets nor a share of messages. Read them as two counts —
                      a channel where the second approaches the first is one the lexicon does not
                      cover.
                    </InfoTip>
                  </>,
                ]}
              >
                {channels.map((channel) => (
                  <Row key={channel.channel}>
                    <Cell>
                      <ChannelBadge channel={channel.channel} />
                    </Cell>
                    <Cell>{channel.ticketsPrimary.toLocaleString()}</Cell>
                    <Cell>
                      <Share
                        value={channel.ticketsPrimary}
                        of={areaTickets}
                        label={`${channelLabel(channel.channel)} share of tickets`}
                      />
                    </Cell>
                    <Cell className={channel.unread > 0 ? 'text-[var(--color-caution)]' : ''}>
                      {channel.unread.toLocaleString()}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
          </section>

          <h2 className="mb-1 text-base font-semibold">Why those tickets existed</h2>
          <p className="mb-3 max-w-2xl text-sm text-[var(--muted-foreground)]">
            Recorded by the agent who finished each ticket, counted on the day they finished it —
            the cause becomes knowable when somebody works it out, not when the ticket arrived. The
            count below is of tickets about a delivery, a parcel&apos;s condition, a pickup, a
            return or a payment: those are the ones an agent must record a cause for, and the only
            ones it would mean anything to count.
          </p>

          {/*
            The honesty line. A cause report drawn from a third of the tickets is
            not wrong, but it is not what it looks like either, so the gap is
            stated before the numbers rather than left for somebody to discover.

            It renders at zero too, which is the change: hiding it when nothing
            owed a cause left three empty tables under a heading with no
            explanation, which reads as a half-finished page rather than as an
            empty one.
          */}
          <p
            className={`mb-4 max-w-2xl rounded-xl border p-3 text-sm ${
              coverage.total > 0 && missing > coverage.withCause
                ? 'border-amber-500/40 bg-amber-500/5'
                : 'border-[var(--border)] bg-[var(--surface)]'
            }`}
          >
            {coverage.total === 0 ? (
              <>
                No ticket resolved in this window owed a cause — nothing about a delivery, a
                parcel&rsquo;s condition, a pickup, a return or a payment was finished between{' '}
                {range.from} and {range.to}. The two tables below are empty for that reason rather
                than because agents skipped the question.
              </>
            ) : (
              <>
                <b>{coverage.withCause.toLocaleString()}</b> of{' '}
                <b>{coverage.total.toLocaleString()}</b> tickets that owed a cause in this window
                have one recorded
                {missing > 0 ? (
                  <>
                    {' '}
                    — the other {missing.toLocaleString()} ended without one, so everything below
                    describes {covered}% of the work.
                  </>
                ) : (
                  '.'
                )}
              </>
            )}
          </p>

          <section className="mb-8">
            <h3 className="mb-2 text-sm font-medium text-[var(--muted-foreground)]">Who owns it</h3>
            {owners.length === 0 ? (
              <Quiet>
                No cause has been recorded in this window, so there is nothing to attribute yet.
              </Quiet>
            ) : (
              <>
                <Table head={['Owner', 'Tickets', 'Share']}>
                  {owners.map((owner) => (
                    <Row key={owner.owner}>
                      <Cell>
                        <Badge tone={owner.owner === 'platform' ? 'warning' : 'neutral'}>
                          {owner.owner}
                        </Badge>
                      </Cell>
                      <Cell>{owner.ticketsResolved.toLocaleString()}</Cell>
                      <Cell>
                        <Share
                          value={owner.ticketsResolved}
                          of={ownerTotal}
                          label={`${owner.owner} share of causes`}
                          tone={owner.owner === 'platform' ? 'warning' : 'neutral'}
                        />
                      </Cell>
                    </Row>
                  ))}
                </Table>
                <p className="mt-2 max-w-2xl text-xs text-[var(--muted-foreground)]">
                  <code>platform</code> is us. Every ticket attributed there is one the product
                  could have prevented — a customer who tried to do it themselves and could not —
                  which makes it the most actionable row in the table rather than the most
                  embarrassing one.
                </p>
              </>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium text-[var(--muted-foreground)]">By cause</h3>
            {causes.length === 0 ? (
              <Quiet>
                Nothing yet. A cause is picked from a list when an agent resolves a ticket in one of
                the five areas above, so this table fills up as those tickets are finished rather
                than as they arrive.
              </Quiet>
            ) : (
              <Table head={['Cause', 'Owner', 'Tickets']}>
                {causes.map((cause) => (
                  <Row key={cause.causeKey}>
                    <Cell>
                      <span className="font-medium">{cause.label}</span>
                      <p className="text-xs text-[var(--muted-foreground)]">{cause.causeKey}</p>
                    </Cell>
                    <Cell>
                      <Badge tone={cause.owner === 'platform' ? 'warning' : 'neutral'}>
                        {cause.owner}
                      </Badge>
                    </Cell>
                    <Cell>{cause.ticketsResolved.toLocaleString()}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * A section with no rows, said in a sentence rather than drawn as a table.
 *
 * A `Table` with an empty body renders as a header strip over nothing, which is
 * what made the bottom half of this page read as unfinished. Every one of these
 * says *why* it is empty, because on this page the three reasons — no data
 * rolled up, no ticket owed a cause, nobody has resolved one yet — are different
 * problems with different answers.
 */
function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--muted-foreground)]">
      {children}
    </p>
  );
}

/**
 * A percentage with the bar that makes a column of them scannable.
 *
 * The number stays: a bar alone is a figure reachable only by measuring a
 * length, and the shares here are small enough that several rows would draw the
 * same sliver. `—` rather than 0% when there is nothing to divide by, so an
 * empty window does not read as a real zero.
 */
function Share({
  value,
  of,
  label,
  tone = 'neutral',
}: {
  value: number;
  of: number;
  label: string;
  tone?: 'good' | 'warning' | 'critical' | 'neutral';
}) {
  if (of <= 0) return <span className="text-[var(--muted-foreground)]">—</span>;

  const percentage = Math.round((100 * value) / of);

  // Divs rather than spans: `Meter` renders a div, and a div inside a span is
  // invalid phrasing content that React will happily produce and the browser
  // will then re-parent, which moves the bar out of its own row.
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 shrink-0 text-[var(--muted-foreground)]">{percentage}%</span>
      <div className="w-24 max-w-full">
        <Meter value={percentage} tone={tone} label={label} />
      </div>
    </div>
  );
}
