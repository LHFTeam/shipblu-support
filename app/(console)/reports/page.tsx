import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { Stat } from '@/components/charts';
import { buttonClass, Cell, EmptyState, Notice, PageHeader, Row, Table } from '@/components/ui';
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
  responsesHint,
  rolledUpDays,
  totals,
  type Row as ReportRow,
} from '@/lib/reports/queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { RangeNav } from './range-nav';

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

  // One window, in the team's zone, for every query and for the dates printed
  // above them, so a figure and its range cannot disagree about where the
  // window starts (§6.54).
  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);

  const [summary, agentRows, groupRows, channelRows, series, rolledUp] = await Promise.all([
    totals(range),
    byAgent(range),
    byGroup(range),
    byChannel(range),
    daily(range),
    rolledUpDays(range),
  ]);

  const hasData = series.length > 0;
  // The history starting inside the window is what makes the range buttons
  // look broken: every wider window answers the same. `first` is the history's
  // start, not the first row in the window, so a window opening on a quiet
  // day does not claim the history is younger than it is.
  const startsLate = rolledUp.first !== null && rolledUp.first > range.from;

  return (
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Reports"
        description={`${range.from} to ${range.to}, in ${zone}. Rolled up nightly — today is not included yet.`}
        actions={
          <>
            <RangeNav ranges={RANGES} current={days} href={(each) => `/reports?days=${each}`} />
            {can(agent, 'report.agents') ? (
              <Link
                href={`/reports/agents?days=${days}`}
                className={buttonClass({ variant: 'secondary', size: 'sm' })}
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
                className={buttonClass({ variant: 'secondary', size: 'sm' })}
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
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              What tickets are about
            </Link>
            {/*
              Also `report.view`: how the reply box's suggestions are doing is a
              question about the team's replies, the same audience as this page.
            */}
            <Link
              href={`/reports/canned-suggestions?days=${days}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Suggested responses
            </Link>
            {/*
              `report.view` too: what customers said of the work is this page's
              CSAT tile, cut every way it can be and with the words beside it.
            */}
            <Link
              href={`/reports/csat?days=${days}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Customer satisfaction
            </Link>
          </>
        }
      />

      {startsLate ? (
        <Notice tone="info" icon className="mb-6 max-w-2xl">
          This window opens on {range.from}, but the rolled-up history{' '}
          <b>begins on {rolledUp.first}</b> — {rolledUp.days} {rolledUp.days === 1 ? 'day' : 'days'}{' '}
          of figures in this window. A wider range cannot reach further back than that until more
          history accumulates.
        </Notice>
      ) : null}

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
              hint={
                <>
                  {responsesHint(summary)} ·{' '}
                  <Link
                    href={`/reports/csat?days=${days}`}
                    className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                  >
                    Details
                  </Link>
                </>
              }
            />
            <Stat label="Reopened" value={summary.ticketsReopened.toLocaleString()} />
          </section>

          <Breakdown
            title="By agent"
            hint="A ticket on a WhatsApp number with an owner counts against that owner, whoever worked it; any other ticket against whoever held it. CSAT is the exception: it stays with the agent each survey was about."
            rows={agentRows}
          />
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
            <h2 className="mb-2 text-sm font-semibold text-(--color-text-secondary)">By day</h2>
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
  hint,
  rows,
  marks,
}: {
  title: string;
  /** Says whose a row's tickets are, where that is not obvious from the title. */
  hint?: string;
  rows: ReportRow[];
  /** Optional per-row element shown instead of the plain label. */
  marks?: Record<string, React.ReactNode>;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="mb-8">
      <h2
        className={`${hint ? 'mb-1' : 'mb-2'} text-sm font-semibold text-(--color-text-secondary)`}
      >
        {title}
      </h2>
      {hint ? <p className="mb-2 text-xs text-(--color-text-tertiary)">{hint}</p> : null}
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
