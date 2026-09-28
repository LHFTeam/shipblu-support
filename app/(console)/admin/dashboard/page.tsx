import { DateTime } from 'luxon';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import {
  agentLoad,
  channelLoad,
  queueSnapshot,
  systemHealth,
  todayByHour,
  todaySoFar,
} from '@/lib/reports/live';
import { reportingContext } from '@/lib/reports/rollup';
import { averageSeconds, daily, metPercentage, totals } from '@/lib/reports/queries';
import { LiveTicker } from './live';
import { AgentLoad } from './agents';
import { ChannelLoad } from './channels';
import { Health } from './health';
import { History, RANGES } from './history';
import { RightNow } from './right-now';
import type { Point } from './section';
import { TodaySoFar } from './today';

export const dynamic = 'force-dynamic';

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
 *  - **The last N days** — the stored rollups Reports reads, over the last N
 *    *complete* days. Reports' window follows `rangeIn` and ends on today,
 *    which has no row yet, so for the same N it sums one day fewer.
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

  // The last `days` complete days, ending yesterday in the team's zone: the
  // days `densify` draws below, and what the history section says it shows
  // ("Complete days only — today is above"). Not `rangeIn`, which ends today
  // for the reports, where the page prints that today is not in yet — so
  // `/reports?days=N` sums N-1 complete days to this page's N.
  const midnight = DateTime.now().setZone(context.zone).startOf('day');
  const history = {
    from: midnight.minus({ days }).toISODate()!,
    to: midnight.minus({ days: 1 }).toISODate()!,
  };

  const [queue, today, agentRows, channels, health, hourly, series, window] = await Promise.all([
    queueSnapshot(now),
    todaySoFar(context, now),
    agentLoad(),
    channelLoad(),
    systemHealth(),
    todayByHour(context.zone, now),
    daily(history),
    totals(history),
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
      <RightNow queue={queue} now={now} online={online} agentRows={agentRows} />

      {/* -------------------------------------------------------- Today so far */}
      <TodaySoFar
        today={today}
        context={context}
        hasHistory={hasHistory}
        recent={recent}
        windowFirstResponse={windowFirstResponse}
        days={days}
        todaySla={todaySla}
        firstResponseSla={firstResponseSla}
        hourly={hourly}
      />

      {/* ----------------------------------------------------------- Historical */}
      <History
        days={days}
        hasHistory={hasHistory}
        trend={trend}
        window={window}
        firstResponseSla={firstResponseSla}
      />

      {/* --------------------------------------------------------------- Agents */}
      <AgentLoad agentRows={agentRows} now={now} />

      {/* ------------------------------------------------------------- Channels */}
      <ChannelLoad channels={channels} />

      {/* --------------------------------------------------------------- Health */}
      <Health health={health} />
    </>
  );
}

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
