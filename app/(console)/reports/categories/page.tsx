import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Badge, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import {
  areaTotals,
  categoryTotals,
  causeCoverage,
  causeTotals,
  ownerTotals,
} from '@/lib/reports/category-queries';

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

  const [categories, areas, causes, owners, coverage] = await Promise.all([
    categoryTotals(days),
    areaTotals(days),
    causeTotals(days),
    ownerTotals(days),
    causeCoverage(days),
  ]);

  const areaTotal = areas.reduce((sum, area) => sum + area.ticketsAny, 0);
  const ownerTotal = owners.reduce((sum, owner) => sum + owner.ticketsResolved, 0);
  const missing = coverage.total - coverage.withCause;

  return (
    <>
      <PageHeader
        title="What tickets are about"
        description="Demand by category, and — the half that matters — why those tickets existed and who owns fixing it."
        actions={
          <nav className="flex gap-1">
            {RANGES.map((range) => (
              <Link
                key={range}
                href={`/reports/categories?days=${range}`}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  range === days
                    ? 'border-[var(--border)] bg-[var(--muted)]'
                    : 'border-transparent hover:bg-[var(--muted)]'
                }`}
              >
                {range} days
              </Link>
            ))}
          </nav>
        }
      />

      {categories.length === 0 && causes.length === 0 ? (
        <EmptyState
          title="Nothing rolled up yet"
          hint="These figures come from the nightly rollup, so a category assigned today appears tomorrow. Run npm run job -- rollup_metrics to build them now."
        />
      ) : (
        <>
          {/*
            Said once, at the top, because it is the one thing that makes every
            number below readable. A ticket routinely carries two or three
            categories, so the column does not sum to the ticket count — and
            without this sentence the first person to add it up files a bug.
          */}
          <p className="mb-6 max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm opacity-80">
            A ticket can be about more than one thing, so <b>Mentioned</b> counts every ticket
            carrying a category and does not add up to the number of tickets. <b>Leading</b> counts
            each ticket once, under whichever category leads it — that is the column to compare
            against a ticket count.
          </p>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-medium">By area</h2>
            <Table head={['Area', 'Tickets mentioning it', 'Share']}>
              {areas.map((area) => (
                <Row key={area.area}>
                  <Cell className="font-medium">{area.area}</Cell>
                  <Cell>{area.ticketsAny}</Cell>
                  <Cell className="opacity-70">
                    {areaTotal > 0 ? `${Math.round((100 * area.ticketsAny) / areaTotal)}%` : '—'}
                  </Cell>
                </Row>
              ))}
            </Table>
          </section>

          <section className="mb-10">
            <h2 className="mb-2 text-sm font-medium">By category</h2>
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
                    change when somebody agrees with it, and counting confirmations here would make
                    last week&rsquo;s figures move every time the queue is worked through.{' '}
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
                    <p className="text-xs opacity-50">{category.categoryKey}</p>
                  </Cell>
                  <Cell>{category.ticketsPrimary}</Cell>
                  <Cell className="opacity-70">{category.ticketsAny}</Cell>
                  <Cell className="text-xs opacity-70">
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
          </section>

          <h2 className="mb-1 text-sm font-medium">Why those tickets existed</h2>
          <p className="mb-3 max-w-2xl text-sm opacity-70">
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
          */}
          {coverage.total > 0 ? (
            <p
              className={`mb-4 rounded-xl border p-3 text-sm ${
                missing > coverage.withCause
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'border-[var(--border)] bg-[var(--surface)]'
              }`}
            >
              <b>{coverage.withCause}</b> of <b>{coverage.total}</b> tickets that owed a cause in
              this window have one recorded
              {missing > 0 ? (
                <>
                  {' '}
                  — the other {missing} ended without one, so everything below describes{' '}
                  {Math.round((100 * coverage.withCause) / coverage.total)}% of the work.
                </>
              ) : (
                '.'
              )}
            </p>
          ) : null}

          <section className="mb-8">
            <h3 className="mb-2 text-sm font-medium">Who owns it</h3>
            <Table head={['Owner', 'Tickets', 'Share']}>
              {owners.map((owner) => (
                <Row key={owner.owner}>
                  <Cell>
                    <Badge tone={owner.owner === 'platform' ? 'warning' : 'neutral'}>
                      {owner.owner}
                    </Badge>
                  </Cell>
                  <Cell>{owner.ticketsResolved}</Cell>
                  <Cell className="opacity-70">
                    {ownerTotal > 0
                      ? `${Math.round((100 * owner.ticketsResolved) / ownerTotal)}%`
                      : '—'}
                  </Cell>
                </Row>
              ))}
            </Table>
            <p className="mt-2 max-w-2xl text-xs opacity-60">
              <code>platform</code> is us. Every ticket attributed there is one the product could
              have prevented — a customer who tried to do it themselves and could not — which makes
              it the most actionable row in the table rather than the most embarrassing one.
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">By cause</h3>
            <Table head={['Cause', 'Owner', 'Tickets']}>
              {causes.map((cause) => (
                <Row key={cause.causeKey}>
                  <Cell>
                    <span className="font-medium">{cause.label}</span>
                    <p className="text-xs opacity-50">{cause.causeKey}</p>
                  </Cell>
                  <Cell>
                    <Badge>{cause.owner}</Badge>
                  </Cell>
                  <Cell>{cause.ticketsResolved}</Cell>
                </Row>
              ))}
            </Table>
          </section>
        </>
      )}
    </>
  );
}
