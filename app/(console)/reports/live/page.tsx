import { DateTime } from 'luxon';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { allLimited } from '@/lib/concurrency';
import {
  agentLoad,
  backlogCuts,
  queueSnapshot,
  systemHealth,
  todayByHour,
  todaySoFar,
} from '@/lib/reports/live';
import { reportingContext } from '@/lib/reports/rollup';
import { averageSeconds, daily, metPercentage, perDay, totals } from '@/lib/reports/queries';
import { LiveTicker } from './live';
import { AgentLoad } from './agents';
import { CategoryLoad } from './categories';
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
 *  - **Right now** — the live backlog: one scan over open tickets, and the
 *    tables below that cut the same backlog by agent, channel and category.
 *  - **Today so far** — computed by the same code the nightly rollup runs, so
 *    the figure here today and the row in `metrics_daily` tomorrow agree.
 *  - **The last N days** — the stored rollups Reports reads, over the last N
 *    *complete* days. Reports' window follows `rangeIn` and ends on today,
 *    which has no row yet, so for the same N it sums one day fewer.
 *
 * It refreshes itself, which is what makes the bounded queries in
 * `lib/reports/live` a requirement rather than a preference.
 *
 * It lived under Settings as `/admin/dashboard` and moved here because it is a
 * report, read rather than configured; `next.config.ts` sends the old address
 * on, for the wallboards bookmarked on it. It kept its key, `admin.agents`,
 * rather than taking `report.view` with the move: past the queue it shows the
 * worker's health — jobs given up on, webhooks left unprocessed, how far the
 * rollup reaches — and every agent's load and presence by name, and the gate
 * has always been the admins'. Opening it to supervisors may be right, but it
 * is a decision about who watches the machinery, for a change of its own, not a
 * side effect of the page changing address.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const agent = await requirePermission('admin.agents');

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
  // days the trend draws below, and what the history section says it shows
  // ("Complete days only — today is above"). Not `rangeIn`, which ends today
  // for the reports, where the page prints that today is not in yet — so
  // `/reports?days=N` sums N-1 complete days to this page's N.
  const midnight = DateTime.now().setZone(context.zone).startOf('day');
  const history = {
    from: midnight.minus({ days }).toISODate()!,
    to: midnight.minus({ days: 1 }).toISODate()!,
  };

  // Three at a time, not all at once. Every read here holds one statement at
  // a time but `systemHealth`, which runs three together, so `Promise.all` put
  // ten on the pool at once against the eight places the admission gate
  // allows — every twenty seconds per open tab, taking every place from every
  // other request for the length of the render (§6.91). `todaySoFar` goes
  // first because it is the long pole, five statements one after another and
  // so the render's floor whatever the others do: started first, the rest fit
  // in beside it. The channel and category tables are one statement
  // (`backlogCuts`), so they are one moment's queue.
  const [today, queue, agentRows, cuts, health, hourly, series, window] = await allLimited(3, [
    () => todaySoFar(context, now),
    () => queueSnapshot(now),
    () => agentLoad(),
    () => backlogCuts(),
    () => systemHealth(),
    () => todayByHour(context.zone, now),
    () => daily(history),
    () => totals(history),
  ]);

  const online = agentRows.filter((agent) => agent.presence === 'online').length;
  const trend: Point[] = perDay(history, series).map(({ day, label, row }) => ({
    day,
    label,
    created: row?.ticketsCreated ?? 0,
    resolved: row?.ticketsResolved ?? 0,
  }));
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
    // Its own scroll container, as every report brings: the console shell does
    // not scroll, and the settings layout that gave it one is no longer above it.
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Live dashboard"
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
        canViewReports={can(agent, 'report.view')}
      />

      {/* --------------------------------------------------------------- Agents */}
      <AgentLoad agentRows={agentRows} now={now} />

      {/* ------------------------------------------------------------- Channels */}
      <ChannelLoad channels={cuts.channels} />

      {/* ----------------------------------------------------------- Categories */}
      <CategoryLoad categories={cuts.categories} />

      {/* --------------------------------------------------------------- Health */}
      <Health health={health} now={now} />
    </div>
  );
}
