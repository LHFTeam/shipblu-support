import Link from 'next/link';
import { DateTime } from 'luxon';
import { ChannelBadge } from '@/components/channel';
import { Columns, Meter, Sparkline, Stat } from '@/components/charts';
import { Badge, Card, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { formatDateTime, formatRelative } from '@/lib/format';
import {
  agentLoad,
  channelLoad,
  queueSnapshot,
  systemHealth,
  todayByHour,
  todaySoFar,
} from '@/lib/reports/live';
import { reportingContext } from '@/lib/reports/rollup';
import {
  averageRating,
  averageSeconds,
  daily,
  formatDuration,
  metPercentage,
  totals,
} from '@/lib/reports/queries';
import { LiveTicker } from './live';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * The live dashboard.
 *
 * Reports answers "how did last month go"; this page answers "what is happening
 * now, and is that normal" — and it has to answer both halves at once, because
 * neither is worth much alone. A queue of forty open tickets means nothing
 * until you know whether forty is a Tuesday or a crisis.
 *
 * So the page is in three registers, and says which is which rather than
 * blending them into one wall of numbers:
 *
 *  - **Right now** — the live backlog, one scan over open tickets.
 *  - **Today so far** — computed by the same code the nightly rollup runs, so
 *    the figure here today and the row in `metrics_daily` tomorrow agree.
 *  - **The last N days** — the stored rollups, exactly what Reports reads.
 *
 * It refreshes itself, which is what makes the bounded queries in
 * `lib/reports/live` a requirement rather than a preference.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requirePermission('admin.agents');

  const { days: requested } = await searchParams;
  const days = RANGES.includes(Number(requested) as (typeof RANGES)[number])
    ? Number(requested)
    : 30;

  const now = new Date();

  // The zone and the calendars first, because both halves of the page are
  // measured against them: which day "today" is, and whose working hours a
  // response time is counted in. One read, rather than one per query that
  // needs it.
  const context = await reportingContext();

  const [queue, today, agentRows, channels, health, hourly, series, window] = await Promise.all([
    queueSnapshot(now),
    todaySoFar(context, now),
    agentLoad(),
    channelLoad(),
    systemHealth(),
    todayByHour(context.zone, now),
    daily(days),
    totals(days),
  ]);

  const online = agentRows.filter((agent) => agent.presence === 'online').length;
  const trend = densify(series, days, context.zone, today.day);
  const recent = trend.slice(-14);
  const hasHistory = series.length > 0;

  const firstResponseSla = metPercentage(
    window.slaFirstResponseMet,
    window.slaFirstResponseBreached,
  );
  const todaySla = metPercentage(
    today.bucket.slaFirstResponseMet,
    today.bucket.slaFirstResponseBreached,
  );
  // Null on a fresh deployment. Every hint that quotes it has to say so in
  // words: appending a bare "—" to "Mean of 4 ·" reads as a broken number.
  const windowFirstResponse = averageSeconds(
    window.firstResponseSecondsSum,
    window.firstResponseCount,
  );

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="The queue as it stands, today as it happens, and how both compare with the weeks behind them."
        actions={<LiveTicker renderedAt={now.toISOString()} />}
      />

      {/* ---------------------------------------------------------- Right now */}
      <Section
        title="Right now"
        hint="Open and pending tickets, read live. Resolved and closed work is not counted."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:col-span-2">
            <p className="text-xs text-[var(--muted-foreground)]">Open right now</p>
            <p className="mt-1 text-5xl font-semibold [font-variant-numeric:proportional-nums]">
              {(queue.open + queue.pending).toLocaleString('en-GB')}
            </p>
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              {queue.open.toLocaleString('en-GB')} open · {queue.pending.toLocaleString('en-GB')}{' '}
              pending
              {queue.onHold > 0
                ? ` · ${queue.onHold.toLocaleString('en-GB')} with the clock stopped`
                : ''}
            </p>
            <p className="mt-3">
              <Link
                href="/inbox?status=unresolved"
                className="text-xs text-brand-600 hover:underline dark:text-brand-300"
              >
                Open the inbox →
              </Link>
            </p>
          </div>

          <Stat
            label="Waiting on us"
            value={queue.awaitingReply.toLocaleString('en-GB')}
            hint={`${queue.awaitingFirstReply.toLocaleString('en-GB')} never answered`}
            tone={queue.awaitingReply > 0 ? 'caution' : undefined}
          />
          <Stat
            label="Unassigned"
            value={queue.unassigned.toLocaleString('en-GB')}
            hint={queue.unassigned > 0 ? 'Nobody has picked these up' : 'Everything has an owner'}
            tone={queue.unassigned > 0 ? 'caution' : undefined}
          />
          <Stat
            label="SLA breached"
            value={queue.breached.toLocaleString('en-GB')}
            hint="First response or resolution, already past due"
            tone={queue.breached > 0 ? 'critical' : undefined}
          />
          <Stat
            label="Due within the hour"
            value={queue.dueWithinHour.toLocaleString('en-GB')}
            hint="Still savable"
            tone={queue.dueWithinHour > 0 ? 'caution' : undefined}
          />
          <Stat
            label="Longest wait"
            value={
              queue.oldestWaitingSince
                ? formatDuration(
                    Math.round((now.getTime() - queue.oldestWaitingSince.getTime()) / 1000),
                  )
                : '—'
            }
            hint={
              queue.oldestWaitingSince
                ? `Since ${formatDateTime(queue.oldestWaitingSince)}`
                : 'Nothing is waiting on a reply'
            }
          />
          <Stat
            label="Agents online"
            value={`${online} / ${agentRows.length}`}
            hint="Signed in and active"
          />
        </div>
      </Section>

      {/* -------------------------------------------------------- Today so far */}
      <Section
        title="Today so far"
        hint={`${formatDay(today.day, context.zone)} — measured by the same code that writes tonight's rollup, so today's figure and tomorrow's report agree. Response times are working hours.`}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* The sparkline is what turns a live number into a judgement: four
              tickets is a quiet morning or a collapse depending entirely on the
              fortnight behind it, and the tile is the only place both fit. */}
          <Stat
            label="Created"
            value={today.bucket.ticketsCreated.toLocaleString('en-GB')}
            hint={
              hasHistory
                ? `${recent.map((point) => point.created).at(-1) ?? 0} yesterday`
                : undefined
            }
          >
            {hasHistory ? (
              <Sparkline
                values={recent.map((point) => point.created)}
                label={`Tickets created on each of the last ${recent.length} days`}
              />
            ) : null}
          </Stat>
          <Stat
            label="Resolved"
            value={today.bucket.ticketsResolved.toLocaleString('en-GB')}
            hint={
              hasHistory
                ? `${recent.map((point) => point.resolved).at(-1) ?? 0} yesterday`
                : undefined
            }
          >
            {hasHistory ? (
              <Sparkline
                values={recent.map((point) => point.resolved)}
                color="var(--series-2)"
                label={`Tickets resolved on each of the last ${recent.length} days`}
              />
            ) : null}
          </Stat>
          <Stat
            label="First response"
            value={formatDuration(
              averageSeconds(today.bucket.firstResponseSecondsSum, today.bucket.firstResponseCount),
            )}
            hint={`Mean of ${today.bucket.firstResponseCount.toLocaleString('en-GB')}${
              windowFirstResponse === null
                ? ''
                : ` · ${formatDuration(windowFirstResponse)} over ${days} days`
            }`}
          />
          <Stat
            label="First response within SLA"
            value={todaySla === null ? '—' : `${todaySla}%`}
            hint={
              firstResponseSla === null
                ? `Nothing to compare with yet over ${days} days`
                : `${firstResponseSla}% over ${days} days`
            }
          >
            <Meter
              value={todaySla}
              tone={slaTone(todaySla)}
              label="First response within SLA, today"
            />
          </Stat>
        </div>

        <Card className="mt-3">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Messages through the day</h3>
            <p className="text-xs text-[var(--muted-foreground)]">
              Hour by hour, in {context.zone.replace('_', ' ')}. Private notes are not counted.
            </p>
          </div>

          {hourly.length === 0 ? (
            <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">
              Nothing has come in yet today.
            </p>
          ) : (
            <>
              <Columns
                caption="Inbound and outbound messages for each hour of today"
                labels={hourly.map((bucket) => String(bucket.hour).padStart(2, '0'))}
                tickEvery={hourly.length > 12 ? 3 : 2}
                series={[
                  {
                    label: 'From customers',
                    values: hourly.map((bucket) => bucket.inbound),
                    color: 'var(--series-1)',
                  },
                  {
                    label: 'From us',
                    values: hourly.map((bucket) => bucket.outbound),
                    color: 'var(--series-2)',
                  },
                ]}
                height={120}
              />
              <TableView
                summary="Messages by hour, as a table"
                head={['Hour', 'From customers', 'From us']}
                rows={hourly.map((bucket) => [
                  `${String(bucket.hour).padStart(2, '0')}:00`,
                  bucket.inbound.toLocaleString('en-GB'),
                  bucket.outbound.toLocaleString('en-GB'),
                ])}
              />
            </>
          )}
        </Card>
      </Section>

      {/* ----------------------------------------------------------- Historical */}
      <Section
        title={`The last ${days} days`}
        hint="From the nightly rollup, which is what Reports reads. Complete days only — today is above."
        actions={
          <nav className="flex gap-1 text-sm">
            {RANGES.map((range) => (
              <Link
                key={range}
                href={`/admin/dashboard?days=${range}`}
                className={`rounded-md px-2.5 py-1 ${
                  range === days
                    ? 'bg-[var(--muted)] font-medium'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                {range} days
              </Link>
            ))}
          </nav>
        }
      >
        {!hasHistory ? (
          <EmptyState
            title="No rollups yet"
            hint="The nightly job writes the first day of figures tonight. Run `npm run job -- rollup_metrics` to build them now."
          />
        ) : (
          <>
            <Card className="mb-3">
              <h3 className="mb-3 text-sm font-medium">Created and resolved</h3>
              <Columns
                caption={`Tickets created and resolved on each of the last ${days} days`}
                labels={trend.map((point) => point.label)}
                series={[
                  {
                    label: 'Created',
                    values: trend.map((point) => point.created),
                    color: 'var(--series-1)',
                  },
                  {
                    label: 'Resolved',
                    values: trend.map((point) => point.resolved),
                    color: 'var(--series-2)',
                  },
                ]}
                tickEvery={days <= 7 ? 1 : days <= 30 ? 5 : 10}
              />
              <TableView
                summary="Created and resolved by day, as a table"
                head={['Day', 'Created', 'Resolved']}
                rows={trend.map((point) => [
                  point.day,
                  point.created.toLocaleString('en-GB'),
                  point.resolved.toLocaleString('en-GB'),
                ])}
              />
            </Card>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Created"
                value={window.ticketsCreated.toLocaleString('en-GB')}
                hint={`${window.ticketsResolved.toLocaleString('en-GB')} resolved`}
              />
              <Stat
                label="First response"
                value={formatDuration(
                  averageSeconds(window.firstResponseSecondsSum, window.firstResponseCount),
                )}
                hint="Mean, in working hours"
              />
              <Stat
                label="Resolution within SLA"
                value={percentage(
                  metPercentage(window.slaResolutionMet, window.slaResolutionBreached),
                )}
                hint={`${percentage(firstResponseSla)} for first response`}
              >
                <Meter
                  value={metPercentage(window.slaResolutionMet, window.slaResolutionBreached)}
                  tone={slaTone(
                    metPercentage(window.slaResolutionMet, window.slaResolutionBreached),
                  )}
                  label={`Resolution within SLA over ${days} days`}
                />
              </Stat>
              <Stat
                label="CSAT"
                value={
                  averageRating(window.csatRatingSum, window.csatResponseCount)?.toFixed(1) ?? '—'
                }
                hint={`${window.csatResponseCount.toLocaleString('en-GB')} response${window.csatResponseCount === 1 ? '' : 's'} · ${window.ticketsReopened.toLocaleString('en-GB')} reopened`}
              />
            </div>

            <p className="mt-2 text-xs text-[var(--muted-foreground)]">
              Cuts by agent, group and channel live in{' '}
              <Link
                href={`/reports?days=${days}`}
                className="text-brand-600 hover:underline dark:text-brand-300"
              >
                Reports
              </Link>
              .
            </p>
          </>
        )}
      </Section>

      {/* --------------------------------------------------------------- Agents */}
      <Section
        title="Who is holding what"
        hint="Live, and only the tickets still open. An agent with an empty queue is listed too — an empty column and a missing row look the same otherwise."
      >
        {agentRows.length === 0 ? (
          <EmptyState title="No active agents" hint="Invite the team from Settings → Agents." />
        ) : (
          <Table head={['Agent', 'Presence', 'Open', 'Waiting on us', 'Breached', 'Longest wait']}>
            {agentRows.map((agent) => (
              <Row key={agent.id}>
                <Cell className="font-medium">{agent.name}</Cell>
                <Cell>
                  <Badge tone={presenceTone(agent.presence)}>{agent.presence}</Badge>
                  {agent.lastSeenAt && agent.presence !== 'online' ? (
                    <span className="ms-2 text-xs text-[var(--muted-foreground)]">
                      {formatRelative(agent.lastSeenAt)}
                    </span>
                  ) : null}
                </Cell>
                <Cell>{agent.open.toLocaleString('en-GB')}</Cell>
                <Cell>{agent.awaitingReply.toLocaleString('en-GB')}</Cell>
                <Cell>
                  {agent.breached > 0 ? (
                    <Badge tone="danger">{agent.breached}</Badge>
                  ) : (
                    <span className="text-[var(--muted-foreground)]">—</span>
                  )}
                </Cell>
                <Cell className="text-[var(--muted-foreground)]">
                  {agent.oldestWaitingSince
                    ? formatDuration(
                        Math.round((now.getTime() - agent.oldestWaitingSince.getTime()) / 1000),
                      )
                    : '—'}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      {/* ------------------------------------------------------------- Channels */}
      <Section title="Open work by channel" hint="Live, across the same open backlog.">
        {channels.length === 0 ? (
          <EmptyState title="Nothing open" hint="Every conversation has been resolved or closed." />
        ) : (
          <Table head={['Channel', 'Open', 'Waiting on us']}>
            {channels.map((channel) => (
              <Row key={channel.channel}>
                <Cell>
                  <ChannelBadge channel={channel.channel} />
                </Cell>
                <Cell>{channel.open.toLocaleString('en-GB')}</Cell>
                <Cell>{channel.awaitingReply.toLocaleString('en-GB')}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      {/* --------------------------------------------------------------- Health */}
      <Section
        title="Behind the scenes"
        hint="Every reply, every webhook and every one of these figures is produced by the worker. When it stops, nothing else on this page looks wrong — which is why it is here."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Jobs waiting"
            value={health.jobsPending.toLocaleString('en-GB')}
            hint={
              health.oldestPendingSince
                ? `Oldest queued ${formatRelative(health.oldestPendingSince)} ago · ${health.jobsProcessing} running`
                : `${health.jobsProcessing} running`
            }
            tone={health.jobsPending > 100 ? 'caution' : undefined}
          />
          <Stat
            label="Jobs given up on"
            value={health.jobsDead.toLocaleString('en-GB')}
            hint={`${health.jobsFailed.toLocaleString('en-GB')} retrying`}
            tone={health.jobsDead > 0 ? 'critical' : undefined}
          />
          <Stat
            label="Webhooks unprocessed"
            value={health.webhooksUnprocessed.toLocaleString('en-GB')}
            hint={
              health.oldestWebhookSince
                ? `Oldest received ${formatRelative(health.oldestWebhookSince)} ago`
                : 'Everything received has been handled'
            }
            tone={health.webhooksUnprocessed > 50 ? 'caution' : undefined}
          />
          <Stat
            label="Reports cover up to"
            value={health.lastRollupDay ?? '—'}
            hint={
              health.lastRollupAt
                ? `That day's figures were written ${formatRelative(health.lastRollupAt)} ago`
                : 'The nightly job has never run'
            }
            tone={health.lastRollupAt ? undefined : 'caution'}
          />
        </div>
      </Section>
    </>
  );
}

function Section({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions ? <div className="ms-auto order-last sm:order-none">{actions}</div> : null}
        {hint ? (
          <p className="w-full max-w-3xl text-xs text-[var(--muted-foreground)]">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The table twin every chart on this page carries.
 *
 * Collapsed rather than absent: a chart's values must be reachable without
 * reading a colour or hovering a bar, but a dashboard that prints every number
 * twice by default is unreadable.
 */
function TableView({ summary, head, rows }: { summary: string; head: string[]; rows: string[][] }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        {summary}
      </summary>
      <div className="app-scroll mt-2 max-h-64 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[var(--surface)]">
            <tr className="border-b border-[var(--border)]">
              {head.map((cell) => (
                <th
                  key={cell}
                  className="px-2 py-1 text-start font-medium text-[var(--muted-foreground)]"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]} className="border-b border-[var(--border)] last:border-0">
                {row.map((cell, index) => (
                  <td key={index} className="px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

type Point = { day: string; label: string; created: number; resolved: number };

/**
 * One entry per day in the window, including the days the rollup has no row
 * for.
 *
 * A day with no tickets is a real observation — a public holiday, a weekend —
 * and dropping it would slide every later bar leftwards, quietly turning a
 * six-day gap into a continuous line.
 */
function densify(
  series: { day: string; ticketsCreated: number; ticketsResolved: number }[],
  days: number,
  zone: string,
  today: string,
): Point[] {
  const byDay = new Map(series.map((row) => [row.day, row]));
  const end = DateTime.fromISO(today, { zone });

  return Array.from({ length: days }, (_, index) => {
    const date = end.minus({ days: days - index });
    const day = date.toISODate()!;
    const row = byDay.get(day);

    return {
      day,
      label: date.toFormat('d/M'),
      created: row?.ticketsCreated ?? 0,
      resolved: row?.ticketsResolved ?? 0,
    };
  });
}

function formatDay(day: string, zone: string): string {
  return DateTime.fromISO(day, { zone }).toFormat('cccc d LLLL');
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

/** Green until it slips, amber while it is recoverable, red once it is not. */
function slaTone(value: number | null): 'good' | 'warning' | 'critical' {
  if (value === null || value >= 90) return 'good';
  return value >= 75 ? 'warning' : 'critical';
}

function presenceTone(presence: 'online' | 'away' | 'offline') {
  return presence === 'online' ? 'success' : presence === 'away' ? 'warning' : 'neutral';
}
