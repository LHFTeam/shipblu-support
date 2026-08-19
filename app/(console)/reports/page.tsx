import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { EmptyState } from '@/components/ui';
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
  type Row,
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
            <Table
              head={['Day', 'Created', 'Resolved', 'First response', 'Resolution', 'CSAT']}
              rows={series.map((row) => [
                row.day,
                row.ticketsCreated.toLocaleString(),
                row.ticketsResolved.toLocaleString(),
                formatDuration(averageSeconds(row.firstResponseSecondsSum, row.firstResponseCount)),
                formatDuration(averageSeconds(row.resolutionSecondsSum, row.resolutionCount)),
                averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—',
              ])}
            />
          </section>
        </>
      )}
    </div>
  );
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-4">
      <p className="text-xs opacity-60">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint ? <p className="mt-0.5 text-xs opacity-40">{hint}</p> : null}
    </div>
  );
}

function Breakdown({
  title,
  rows,
  marks,
}: {
  title: string;
  rows: Row[];
  /** Optional per-row element shown instead of the plain label. */
  marks?: Record<string, React.ReactNode>;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-sm font-medium opacity-70">{title}</h2>
      <Table
        head={['', 'Created', 'Resolved', 'First response', 'Within SLA', 'CSAT']}
        rows={rows.map((row) => [
          marks?.[row.label] ?? row.label,
          row.ticketsCreated.toLocaleString(),
          row.ticketsResolved.toLocaleString(),
          formatDuration(averageSeconds(row.firstResponseSecondsSum, row.firstResponseCount)),
          percentage(metPercentage(row.slaFirstResponseMet, row.slaFirstResponseBreached)),
          averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—',
        ])}
      />
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-left">
            {head.map((cell, index) => (
              <th key={cell || index} className="px-3 py-2 text-xs font-medium opacity-60">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-[var(--border)] last:border-0">
              {row.map((cell, index) => (
                <td key={index} className={`px-3 py-2 ${index === 0 ? 'font-medium' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
