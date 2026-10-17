import Link from 'next/link';
import { Meter, Stat } from '@/components/charts';
import {
  Badge,
  buttonClass,
  Card,
  Cell,
  EmptyState,
  PageHeader,
  Row,
  Table,
} from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import {
  adherence,
  agentDays,
  agentSummaries,
  focusMeasured,
  formatClock,
  formatDrift,
  formatHours,
  handlingSeconds,
  minutesEarlyOff,
  minutesLate,
  occupancy,
  reopenRate,
  resolvedPerHour,
  type AgentDayRow,
  type AgentSummary,
} from '@/lib/reports/agent-queries';
import {
  averageRating,
  averageSeconds,
  formatDuration,
  metPercentage,
  responsesHint,
} from '@/lib/reports/queries';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { RangeNav } from '../range-nav';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * Agent productivity: punctuality, availability, speed and efficacy.
 *
 * The sibling of `/reports`, which measures the queue. This one measures the
 * people, and is behind its own permission for that reason — knowing how the
 * team is coping and knowing what time a named person logged in are different
 * things to be trusted with.
 *
 * Every speed column is deliberately printed next to the quality column that
 * constrains it: handling time beside reopen rate, resolution beside CSAT.
 * Handle time and resolution time both improve when tickets are closed before
 * they are finished, and a scorecard that shows the first without the second is
 * the documented way to teach a team to do exactly that.
 *
 * Reads only rolled-up rows, like the rest of reporting, so today appears
 * tomorrow.
 */
export default async function AgentProductivityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; agent?: string }>;
}) {
  const agent = await requirePermission('report.agents');

  const { days: requested, agent: requestedAgent } = await searchParams;
  const days = RANGES.includes(Number(requested) as (typeof RANGES)[number])
    ? Number(requested)
    : 30;

  // The reporting zone, so the window's edges land on the team's midnights
  // rather than on UTC's — the same context the nightly rollup bucketed by.
  const { zone } = await reportingContext();
  const summaries = await agentSummaries(zone, days);

  // Only ever an id we already listed, never the raw query string: the detail
  // query is keyed on it, and an unknown id would simply return nothing while
  // looking like a working page.
  const selected = summaries.find((row) => row.agentId === requestedAgent) ?? null;
  const detail = selected ? await agentDays(zone, days, selected.agentId) : [];

  const { from, to } = rangeIn(zone, days);
  const team = totalsOf(summaries);

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Agent productivity"
        description={`${from} to ${to}, in ${zone}. Rolled up nightly — today is not included yet.`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <RangeNav
              ranges={RANGES}
              current={days}
              href={(each) => link({ days: each, agent: selected?.agentId })}
            />
            <Link
              href={`/reports/agents/export?days=${days}`}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Export CSV
            </Link>
          </div>
        }
      />

      {summaries.length === 0 ? (
        <EmptyState
          title="Nothing measured yet"
          hint="Presence, handling time and backlog are recorded from the moment this ships, so the first figures appear after a day of work and tonight's rollup. Run `npm run job -- rollup_metrics` to build what exists now."
        />
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Time at the desk"
              value={formatHours(team.onlineSeconds)}
              hint="Total across the team"
            />
            <Stat
              label="Available"
              value={formatHours(team.acceptingSeconds)}
              hint="Online and accepting work"
            />
            <Stat
              label="Avg handling time"
              value={formatDuration(handlingSeconds(team))}
              hint="Measured, per conversation worked"
            />
            <Stat
              label="Resolved per online hour"
              value={resolvedPerHour(team)?.toFixed(1) ?? '—'}
            />
            <Card padded={false} className="p-4">
              <Meter
                value={occupancy(team)}
                tone={occupancyTone(occupancy(team))}
                label="Occupancy"
              />
              <p className="mt-1 text-xs text-(--color-text-tertiary)">
                Healthy is 75–85%. Sustained above that costs quality.
              </p>
            </Card>
            <Card padded={false} className="p-4">
              <Meter
                value={adherence(team)}
                tone={adherence(team) !== null && adherence(team)! < 85 ? 'warning' : 'good'}
                label="Schedule adherence"
              />
              <p className="mt-1 text-xs text-(--color-text-tertiary)">
                Target is 85% of the scheduled shift.
              </p>
            </Card>
            <Stat
              label="Reopened after resolve"
              value={team.resolutionsMade > 0 ? `${reopenRate(team) ?? 0}%` : '—'}
              tone={(reopenRate(team) ?? 0) > 15 ? 'caution' : undefined}
              hint="The counterweight to every speed figure here"
            />
            <Stat
              label="CSAT"
              value={averageRating(team.csatRatingSum, team.csatResponseCount)?.toFixed(1) ?? '—'}
              hint={
                // The satisfaction report is `report.view`'s, which this page's
                // own key does not imply: no link to a door that is shut.
                can(agent, 'report.view') ? (
                  <>
                    {responsesHint(team)} ·{' '}
                    <Link
                      href={`/reports/csat?days=${days}`}
                      className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                    >
                      Details
                    </Link>
                  </>
                ) : (
                  responsesHint(team)
                )
              }
            />
          </section>

          <Section title="Punctuality and availability">
            <Table
              head={[
                'Agent',
                'Days',
                'At the desk',
                'Available',
                'Adherence',
                'Occupancy',
                'Sessions',
              ]}
            >
              {summaries.map((row) => (
                <Row key={row.agentId}>
                  <Cell>
                    <AgentLink row={row} days={days} selected={selected?.agentId} />
                  </Cell>
                  <Cell>{row.daysWorked}</Cell>
                  <Cell>{formatHours(row.onlineSeconds)}</Cell>
                  <Cell>{formatHours(row.acceptingSeconds)}</Cell>
                  <Cell>{percentage(adherence(row))}</Cell>
                  <Cell>{percentage(occupancy(row))}</Cell>
                  <Cell>
                    {row.sessionCount}
                    {row.reclaimedFromCount > 0 ? (
                      <span className="ms-2">
                        <Badge tone="warning">{row.reclaimedFromCount} reclaimed</Badge>
                      </span>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </Table>
          </Section>

          <Section
            title="Speed and efficacy"
            hint="Resolved counts resolutions this agent performed, which is what the reopen rate beside it is a share of — not tickets resolved while assigned to them, which is what /reports shows. Handling time is measured while the ticket is open, focused and in use, so it excludes work done in other systems."
          >
            <Table
              head={[
                'Agent',
                'Assigned',
                'Resolved',
                'Replies',
                'Handling time',
                'First response',
                'Within SLA',
                'Reopened',
                'CSAT',
              ]}
            >
              {summaries.map((row) => (
                <Row key={row.agentId}>
                  <Cell>
                    <AgentLink row={row} days={days} selected={selected?.agentId} />
                  </Cell>
                  <Cell>{row.assignedCount}</Cell>
                  <Cell>{row.resolutionsMade}</Cell>
                  <Cell>{row.publicReplies}</Cell>
                  <Cell>
                    {focusMeasured(row) ? (
                      formatDuration(handlingSeconds(row))
                    ) : (
                      // Never "0s": the beat runs in the agent's browser and can
                      // be blocked, so an unmeasured day must not render as an
                      // idle one.
                      <Badge tone="neutral">Not measured</Badge>
                    )}
                  </Cell>
                  <Cell>
                    {formatDuration(
                      averageSeconds(row.firstResponseSecondsSum, row.firstResponseCount),
                    )}
                  </Cell>
                  <Cell>
                    {percentage(
                      metPercentage(row.slaFirstResponseMet, row.slaFirstResponseBreached),
                    )}
                  </Cell>
                  <Cell>{percentage(reopenRate(row))}</Cell>
                  <Cell>
                    {averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—'}
                  </Cell>
                </Row>
              ))}
            </Table>
          </Section>

          {selected ? (
            <Section
              title={`${selected.name}, day by day`}
              hint="Login is the first moment their console connected; logout the last."
            >
              {detail.length === 0 ? (
                <EmptyState title="No days in this range" />
              ) : (
                <Table
                  head={[
                    'Day',
                    'Login',
                    'Logout',
                    'Scheduled',
                    'Punctuality',
                    'At the desk',
                    'Available',
                    'Assigned',
                    'Resolved',
                    'Open at day end',
                    'Handling time',
                    'CSAT',
                  ]}
                >
                  {detail.map((row) => (
                    <Row key={row.day}>
                      <Cell>{row.day}</Cell>
                      <Cell>{formatClock(row.firstOnlineAt, zone)}</Cell>
                      <Cell>{formatClock(row.lastOnlineAt, zone)}</Cell>
                      <Cell className="whitespace-nowrap text-(--color-text-secondary)">
                        {scheduled(row, zone)}
                      </Cell>
                      <Cell>
                        <Punctuality row={row} />
                      </Cell>
                      <Cell>{formatHours(row.onlineSeconds)}</Cell>
                      <Cell>{formatHours(row.acceptingSeconds)}</Cell>
                      <Cell>{row.assignedCount}</Cell>
                      <Cell>{row.resolutionsMade}</Cell>
                      <Cell>{row.openAtDayEnd ?? '—'}</Cell>
                      <Cell>{focusMeasured(row) ? formatDuration(handlingSeconds(row)) : '—'}</Cell>
                      <Cell>
                        {averageRating(row.csatRatingSum, row.csatResponseCount)?.toFixed(1) ?? '—'}
                      </Cell>
                    </Row>
                  ))}
                </Table>
              )}
            </Section>
          ) : (
            <p className="text-sm text-(--color-text-tertiary)">
              Pick an agent above to see their days.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function link({ days, agent }: { days: number; agent?: string }): string {
  const params = new URLSearchParams({ days: String(days) });
  if (agent) params.set('agent', agent);
  return `/reports/agents?${params}`;
}

function AgentLink({
  row,
  days,
  selected,
}: {
  row: AgentSummary;
  days: number;
  selected?: string;
}) {
  return (
    <Link
      href={link({ days, agent: row.agentId })}
      className={`hover:underline ${row.agentId === selected ? 'font-semibold' : 'font-medium'}`}
    >
      {row.name}
    </Link>
  );
}

/**
 * Late, early or on time — and silent when there is nothing to compare against.
 *
 * A day with no schedule and a day the agent never appeared both render as a
 * dash rather than as lateness, because neither is it: one is a day off and the
 * other is an absence, and calling either "late by eight hours" would be the
 * kind of quiet wrongness that makes a team stop trusting the page.
 */
function Punctuality({ row }: { row: AgentDayRow }) {
  const late = minutesLate(row);
  if (late === null) return <span className="text-(--color-text-tertiary)">—</span>;

  // A few minutes either side of the hour is not a finding, it is a browser
  // finishing its handshake.
  if (late <= 5) return <Badge tone="success">On time</Badge>;
  if (late <= 15) return <Badge tone="warning">{formatDrift(late)}</Badge>;
  return <Badge tone="danger">{formatDrift(late)}</Badge>;
}

function scheduled(row: AgentDayRow, zone: string): string {
  if (!row.scheduledStartAt) return 'closed';

  const off = minutesEarlyOff(row);
  const span = `${formatClock(row.scheduledStartAt, zone)}–${formatClock(row.scheduledEndAt, zone)}`;
  return off !== null && off > 15 ? `${span} (left ${formatDrift(off)})` : span;
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** Occupancy has a ceiling as well as a floor, so its tone is not monotonic. */
function occupancyTone(value: number | null): 'good' | 'warning' | 'critical' {
  if (value === null) return 'good';
  if (value > 90) return 'critical';
  if (value > 85 || value < 50) return 'warning';
  return 'good';
}

/** The team's row, summed from the per-agent rows because each agent appears once. */
function totalsOf(rows: AgentSummary[]): AgentSummary {
  const sum = (pick: (row: AgentSummary) => number) =>
    rows.reduce((running, row) => running + pick(row), 0);

  return {
    agentId: '',
    name: 'Team',
    onlineSeconds: sum((r) => r.onlineSeconds),
    acceptingSeconds: sum((r) => r.acceptingSeconds),
    onlineWithinHoursSeconds: sum((r) => r.onlineWithinHoursSeconds),
    scheduledSeconds: sum((r) => r.scheduledSeconds),
    focusSeconds: sum((r) => r.focusSeconds),
    conversationsFocused: sum((r) => r.conversationsFocused),
    sessionCount: sum((r) => r.sessionCount),
    assignedCount: sum((r) => r.assignedCount),
    touchedCount: sum((r) => r.touchedCount),
    publicReplies: sum((r) => r.publicReplies),
    privateNotes: sum((r) => r.privateNotes),
    transferredAwayCount: sum((r) => r.transferredAwayCount),
    reclaimedFromCount: sum((r) => r.reclaimedFromCount),
    resolutionsMade: sum((r) => r.resolutionsMade),
    reopenedAfterResolveCount: sum((r) => r.reopenedAfterResolveCount),
    daysWorked: sum((r) => r.daysWorked),
    ticketsResolved: sum((r) => r.ticketsResolved),
    ticketsCreated: sum((r) => r.ticketsCreated),
    firstResponseSecondsSum: sum((r) => r.firstResponseSecondsSum),
    firstResponseCount: sum((r) => r.firstResponseCount),
    resolutionSecondsSum: sum((r) => r.resolutionSecondsSum),
    resolutionCount: sum((r) => r.resolutionCount),
    slaFirstResponseMet: sum((r) => r.slaFirstResponseMet),
    slaFirstResponseBreached: sum((r) => r.slaFirstResponseBreached),
    slaResolutionMet: sum((r) => r.slaResolutionMet),
    slaResolutionBreached: sum((r) => r.slaResolutionBreached),
    csatRatingSum: sum((r) => r.csatRatingSum),
    csatResponseCount: sum((r) => r.csatResponseCount),
    csatSentCount: sum((r) => r.csatSentCount),
  };
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-semibold text-(--color-text-secondary)">{title}</h2>
      {hint ? <p className="mb-2 text-xs text-(--color-text-tertiary)">{hint}</p> : null}
      {children}
    </section>
  );
}
