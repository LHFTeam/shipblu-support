import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { Stat } from '@/components/charts';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { channelLabel } from '@/lib/format';
import {
  averageRating,
  averageSeconds,
  byAgent,
  byChannel,
  byGroup,
  daily,
  formatDuration,
  metPercentage,
  totals,
  type Row as ReportRow,
} from '@/lib/reports/queries';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * Reporting.
 *
 * Reads only the nightly rollup, so today's numbers appear tomorrow. That is a
 * deliberate trade rather than an oversight: a live version of this page is an
 * aggregate over every message the company has ever received, run every time
 * somebody leaves a tab open.
 */
export default async function ReportsPage({
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

  const [summary, agentRows, groupRows, channelRows, series] = await Promise.all([
    totals(days),
    byAgent(days),
    byGroup(days),
    byChannel(days),
    daily(days),
  ]);

  const hasData = series.length > 0;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Reports</h1>
        <nav className="flex gap-1 text-sm">
          {RANGES.map((range) => (
            <Link
              key={range}
              href={`/reports?days=${range}`}
              className={`rounded-md px-2.5 py-1 ${
                range === days ? 'bg-[var(--muted)] font-medium' : 'opacity-60 hover:opacity-100'
              }`}
            >
              {range} days
            </Link>
          ))}
        </nav>
        {can(agent, 'report.agents') ? (
          <Link
            href={`/reports/agents?days=${days}`}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
          >
            Agent productivity
          </Link>
        ) : null}
        {/*
          Its own key, not `report.agents`: that one reads what people did, and
          this one changes where the next ticket goes.
        */}
        {can(agent, 'agent.availability') ? (
          <Link
            href="/reports/team"
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
          >
            Team availability
          </Link>
        ) : null}
        {/*
          Behind `report.view` like this page rather than a key of its own: it
          answers what the team is being asked about, which is the same question
          this page answers, cut a different way.
        */}
        <Link
          href={`/reports/categories?days=${days}`}
          className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
        >
          What tickets are about
        </Link>
        <p className="ml-auto text-xs opacity-50">Rolled up nightly — today is not included yet.</p>
      </div>

      {!hasData ? (
        <EmptyState
          title="No rollups yet"
          hint="The nightly job writes the first day of figures tonight. Run `npm run job -- rollup_metrics` to build them now."
        />
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Tickets created" value={summary.ticketsCreated.toLocaleString()} />
            <Stat label="Resolved" value={summary.ticketsResolved.toLocaleString()} />
            <Stat
              label="First response"
              value={formatDuration(
                averageSeconds(summary.firstResponseSecondsSum, summary.firstResponseCount),
              )}
              hint="Mean, in working hours"
            />
            <Stat
              label="Resolution time"
              value={formatDuration(
                averageSeconds(summary.resolutionSecondsSum, summary.resolutionCount),
              )}
              hint="Mean, in working hours"
            />
            <Stat
              label="First response within SLA"
              value={percentage(
                metPercentage(summary.slaFirstResponseMet, summary.slaFirstResponseBreached),
              )}
            />
            <Stat
              label="Resolution within SLA"
              value={percentage(
                metPercentage(summary.slaResolutionMet, summary.slaResolutionBreached),
              )}
            />
            <Stat
              label="CSAT"
              value={
                averageRating(summary.csatRatingSum, summary.csatResponseCount)?.toFixed(1) ?? '—'
              }
              hint={`${summary.csatResponseCount} response${summary.csatResponseCount === 1 ? '' : 's'}`}
            />
            <Stat label="Reopened" value={summary.ticketsReopened.toLocaleString()} />
          </section>

          <Breakdown title="By agent" rows={agentRows} />
          <Breakdown title="By group" rows={groupRows} />
          <Breakdown
            title="By channel"
            rows={channelRows.map((row) => ({ ...row, label: channelLabel(row.label) }))}
            marks={Object.fromEntries(
              channelRows.map((row) => [
                channelLabel(row.label),
                <ChannelBadge key={row.label} channel={row.label} />,
              ]),
            )}
          />

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-medium opacity-70">By day</h2>
            <Table head={['Day', 'Created', 'Resolved', 'First response', 'Resolution', 'CSAT']}>
              {series.map((row) => (
                <Row key={row.day}>
                  <Cell className="font-medium">{row.day}</Cell>
                  <Cell>{row.ticketsCreated.toLocaleString()}</Cell>
                  <Cell>{row.ticketsResolved.toLocaleString()}</Cell>
                  <Cell>
                    {formatDuration(
                      averageSeconds(row.firstResponseSecondsSum, row.firstResponseCount),
                    )}
                  </Cell>
                  <Cell>
                    {formatDuration(averageSeconds(row.resolutionSecondsSum, row.resolutionCount))}
                  </Cell>
                  <Cell>
                    {averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—'}
                  </Cell>
                </Row>
              ))}
            </Table>
          </section>
        </>
      )}
    </div>
  );
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function Breakdown({
  title,
  rows,
  marks,
}: {
  title: string;
  rows: ReportRow[];
  /** Optional per-row element shown instead of the plain label. */
  marks?: Record<string, React.ReactNode>;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium opacity-70">{title}</h2>
      <Table head={['', 'Created', 'Resolved', 'First response', 'Within SLA', 'CSAT']}>
        {/* Keyed by position, as the page always was: a label is a display name,
            and two agents can share one. */}
        {rows.map((row, index) => (
          <Row key={index}>
            <Cell className="font-medium">{marks?.[row.label] ?? row.label}</Cell>
            <Cell>{row.ticketsCreated.toLocaleString()}</Cell>
            <Cell>{row.ticketsResolved.toLocaleString()}</Cell>
            <Cell>
              {formatDuration(averageSeconds(row.firstResponseSecondsSum, row.firstResponseCount))}
            </Cell>
            <Cell>
              {percentage(metPercentage(row.slaFirstResponseMet, row.slaFirstResponseBreached))}
            </Cell>
            <Cell>
              {averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—'}
            </Cell>
          </Row>
        ))}
      </Table>
    </section>
  );
}
