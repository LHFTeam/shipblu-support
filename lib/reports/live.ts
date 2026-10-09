import { DateTime } from 'luxon';
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  conversations,
  groupMembers,
  groups,
  jobs,
  messages,
  metricsDaily,
  ticketStatuses,
  webhookEvents,
} from '@/db/schema';
import { openBacklog } from '@/lib/tickets/backlog';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { computeDay, todayIn, totalsOf, type Bucket, type ReportingContext } from './rollup';

/**
 * Read models for the live dashboard.
 *
 * The reports page reads only `metrics_daily`, which is why it is fast and why
 * today is missing from it. This module is the other half — the questions an
 * admin has about *now*, which a nightly rollup can never answer: how big the
 * queue is, who is waiting, whether anything is about to breach.
 *
 * Every query here is bounded on purpose. A live dashboard is a page somebody
 * leaves open on a wall screen, so an unbounded aggregate here would be an
 * aggregate over the whole archive every twenty seconds, for ever. Nothing
 * below scans more than the open backlog or a single day, and the day-ranged
 * scans are the reason `conversations` and `messages` carry indexes on the
 * timestamps those scans filter by.
 */

/**
 * An aggregate over a timestamp column comes back as a Date from postgres.js
 * when drizzle knows the column and as a string when it does not — `min(...)`
 * inside a `filter` clause is the second case. Both are handled here rather
 * than at six call sites.
 */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Live tickets: not deleted, not merged away, not spam, not resolved/closed, and
 * on a channel the team actually works.
 *
 * The last one carries the most weight here. Every figure on this dashboard is a
 * measure of the team — queue depth, who is loaded, what is breaching — and a
 * channel nobody may reply to answers none of those questions while dominating
 * all of them: nineteen hundred bot transcripts against three real tickets would
 * report a backlog that does not exist and an unassigned count nobody can act
 * on.
 *
 * Moved to `lib/tickets/backlog` when assignment started asking the same
 * question: what this page calls an agent's load is what the capacity check
 * calls their count, and the two must not be able to drift.
 */
const liveTickets = openBacklog;

/**
 * The customer spoke last, so the ticket is waiting on us.
 *
 * Written once and reused, because "waiting" appearing with two slightly
 * different definitions on one page is how a dashboard loses an argument.
 */
const AWAITING_US = sql`${conversations.lastCustomerMessageAt} is not null
  and (${conversations.lastAgentMessageAt} is null
    or ${conversations.lastAgentMessageAt} < ${conversations.lastCustomerMessageAt})`;

export type QueueSnapshot = {
  open: number;
  pending: number;
  onHold: number;
  unassigned: number;
  awaitingFirstReply: number;
  awaitingReply: number;
  breached: number;
  dueWithinHour: number;
  oldestWaitingSince: Date | null;
};

/**
 * The queue as it stands.
 *
 * One pass over the open backlog — the population the inbox already shows, so
 * it is the size a support team keeps it at, not the size of the archive.
 * Every figure is a `filter` on that single scan rather than its own round
 * trip, because app↔database latency is most of what this page costs.
 */
export async function queueSnapshot(now: Date = new Date()): Promise<QueueSnapshot> {
  // ISO strings with an explicit cast, not Date objects. A Date interpolated
  // into a `sql` template arrives as an untyped parameter, and postgres.js
  // cannot serialise one of those — drizzle only maps Dates when it knows the
  // column they are being compared against.
  const from = sql`${now.toISOString()}::timestamptz`;
  const until = sql`${new Date(now.getTime() + 3_600_000).toISOString()}::timestamptz`;

  const rows = await db
    .select({
      open: sql<number>`count(*) filter (where ${ticketStatuses.category} = 'open')::int`,
      pending: sql<number>`count(*) filter (where ${ticketStatuses.category} = 'pending')::int`,
      onHold: sql<number>`count(*) filter (where ${ticketStatuses.stopsSlaClock})::int`,
      unassigned: sql<number>`count(*) filter (where ${conversations.assigneeAgentId} is null)::int`,
      awaitingFirstReply: sql<number>`count(*) filter (where ${conversations.firstRespondedAt} is null)::int`,
      awaitingReply: sql<number>`count(*) filter (where ${AWAITING_US})::int`,
      breached: sql<number>`count(*) filter (where ${conversations.firstResponseBreached} or ${conversations.resolutionBreached})::int`,
      // "About to breach" ignores a stopped clock and anything already
      // breached: both are true of tickets nobody can rescue in the next hour.
      dueWithinHour: sql<number>`count(*) filter (
        where not ${ticketStatuses.stopsSlaClock}
          and not ${conversations.resolutionBreached}
          and ${conversations.resolutionDueAt} >= ${from}
          and ${conversations.resolutionDueAt} < ${until})::int`,
      oldestWaitingSince: sql<unknown>`min(${conversations.lastCustomerMessageAt}) filter (where ${AWAITING_US})`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(liveTickets());

  const row = rows[0];

  return {
    open: row?.open ?? 0,
    pending: row?.pending ?? 0,
    onHold: row?.onHold ?? 0,
    unassigned: row?.unassigned ?? 0,
    awaitingFirstReply: row?.awaitingFirstReply ?? 0,
    awaitingReply: row?.awaitingReply ?? 0,
    breached: row?.breached ?? 0,
    dueWithinHour: row?.dueWithinHour ?? 0,
    oldestWaitingSince: asDate(row?.oldestWaitingSince),
  };
}

/**
 * Today's figures, computed the way the nightly rollup computes every other
 * day — so the number on this page today and the row in `metrics_daily`
 * tomorrow are the same measurement, working-hours response times included.
 *
 * This is the one live aggregate on the page, and it is over a day rather than
 * an archive.
 */
export async function todaySoFar(
  context: ReportingContext,
  now: Date = new Date(),
): Promise<{ day: string; bucket: Bucket }> {
  const day = todayIn(context.zone);
  const slices = await computeDay(day, context, now);

  return { day, bucket: totalsOf(slices) };
}

export type AgentLoad = {
  id: string;
  name: string;
  /**
   * What assignment actually sees, not what the column says.
   *
   * `away` is never stored — an agent is connected or they are not — so it is
   * derived here: connected but not accepting. Computing it in one place means
   * the badge on the dashboard and the decision the router makes cannot disagree
   * about who is available.
   */
  presence: 'online' | 'away' | 'offline';
  lastSeenAt: Date | null;
  /** The raw switch, which `presence` above folds into "away". */
  accepting: boolean;
  /**
   * Who turned it off, which is what says whether it will come back on its own.
   * Null whenever they are accepting.
   */
  offReason: 'self' | 'idle' | 'supervisor' | null;
  /**
   * Last key or click in the console. Null for an agent who has not touched it
   * since this was first recorded, which is not the same as idle for ever.
   */
  lastInputAt: Date | null;
  /** Their effective cap, already resolved through the group default. Null is uncapped. */
  maxOpen: number | null;
  open: number;
  awaitingReply: number;
  breached: number;
  oldestWaitingSince: Date | null;
};

/**
 * Who is carrying what, right now.
 *
 * A left join onto the live backlog, so an agent holding nothing still appears:
 * "this queue is empty" and "this agent is missing from the list" look the same
 * otherwise, and only one of them means the work is done.
 */
export async function agentLoad(): Promise<AgentLoad[]> {
  const live = db
    .select({
      assigneeAgentId: conversations.assigneeAgentId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      lastAgentMessageAt: conversations.lastAgentMessageAt,
      breached:
        sql<boolean>`(${conversations.firstResponseBreached} or ${conversations.resolutionBreached})`.as(
          'breached',
        ),
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(liveTickets())
    .as('live');

  const awaiting = sql`${live.lastCustomerMessageAt} is not null
    and (${live.lastAgentMessageAt} is null
      or ${live.lastAgentMessageAt} < ${live.lastCustomerMessageAt})`;

  const rows = await db
    .select({
      id: agents.id,
      name: sql<string>`coalesce(nullif(${agents.name}, ''), ${agents.email})`,
      presence: agents.presence,
      isAcceptingTickets: agents.isAcceptingTickets,
      offReason: agents.acceptingOffReason,
      lastInputAt: agents.lastInputAt,
      lastSeenAt: agents.lastSeenAt,
      // The smallest cap any of their groups would apply, since a ticket from
      // the strictest group is the first one they stop receiving.
      maxOpen: sql<number | null>`coalesce(${agents.maxOpenTickets}, (
        select min(g.default_max_open_tickets)
        from ${groupMembers} gm
        join ${groups} g on g.id = gm.group_id
        where gm.agent_id = ${agents}.id
      ))`,
      open: sql<number>`count(${live.assigneeAgentId})::int`,
      awaitingReply: sql<number>`count(*) filter (where ${awaiting})::int`,
      breached: sql<number>`count(*) filter (where ${live.breached})::int`,
      oldestWaitingSince: sql<unknown>`min(${live.lastCustomerMessageAt}) filter (where ${awaiting})`,
    })
    .from(agents)
    .leftJoin(live, eq(live.assigneeAgentId, agents.id))
    .where(eq(agents.isActive, true))
    .groupBy(agents.id)
    .orderBy(desc(sql`count(${live.assigneeAgentId})`), asc(agents.name));

  return rows.map(({ isAcceptingTickets, ...row }) => ({
    ...row,
    accepting: isAcceptingTickets,
    presence: row.presence === 'online' && !isAcceptingTickets ? ('away' as const) : row.presence,
    oldestWaitingSince: asDate(row.oldestWaitingSince),
  }));
}

export type ChannelLoad = { channel: string; open: number; awaitingReply: number };

/** Open work by channel — the same one-pass scan over the live backlog. */
export async function channelLoad(): Promise<ChannelLoad[]> {
  return db
    .select({
      channel: conversations.channel,
      open: sql<number>`count(*)::int`,
      awaitingReply: sql<number>`count(*) filter (where ${AWAITING_US})::int`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(liveTickets())
    .groupBy(conversations.channel)
    .orderBy(desc(sql`count(*)`));
}

export type SystemHealth = {
  jobsPending: number;
  jobsProcessing: number;
  jobsFailed: number;
  jobsDead: number;
  oldestPendingSince: Date | null;
  webhooksUnprocessed: number;
  oldestWebhookSince: Date | null;
  lastRollupAt: Date | null;
  lastRollupDay: string | null;
};

/**
 * Whether the machinery behind the numbers is actually running.
 *
 * This belongs on an admin dashboard rather than in reporting: a dead job is
 * invisible on every other screen — replies simply stop being sent — and the
 * first sign is usually a customer asking why nobody answered.
 *
 * Bounded by the queue, which the cleanup job keeps short; completed jobs are
 * never counted.
 */
export async function systemHealth(): Promise<SystemHealth> {
  const [queue, hooks, rollup] = await Promise.all([
    db
      .select({
        pending: sql<number>`count(*) filter (where ${jobs.status} = 'pending')::int`,
        processing: sql<number>`count(*) filter (where ${jobs.status} = 'processing')::int`,
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
        dead: sql<number>`count(*) filter (where ${jobs.status} = 'dead')::int`,
        oldestPendingSince: sql<unknown>`min(${jobs.runAt}) filter (where ${jobs.status} = 'pending')`,
      })
      .from(jobs)
      .where(inArray(jobs.status, ['pending', 'processing', 'failed', 'dead'])),

    db
      .select({
        unprocessed: sql<number>`count(*)::int`,
        oldest: sql<unknown>`min(${webhookEvents.receivedAt})`,
      })
      .from(webhookEvents)
      .where(isNull(webhookEvents.processedAt)),

    // Ordered by the day covered, not by when the row was written: the
    // question this answers is "how far does the reporting data reach", and a
    // manual recompute of an old day would otherwise present itself as the
    // newest thing the rollup knows about.
    db
      .select({ day: metricsDaily.day, computedAt: metricsDaily.computedAt })
      .from(metricsDaily)
      .orderBy(desc(metricsDaily.day))
      .limit(1),
  ]);

  return {
    jobsPending: queue[0]?.pending ?? 0,
    jobsProcessing: queue[0]?.processing ?? 0,
    jobsFailed: queue[0]?.failed ?? 0,
    jobsDead: queue[0]?.dead ?? 0,
    oldestPendingSince: asDate(queue[0]?.oldestPendingSince),
    webhooksUnprocessed: hooks[0]?.unprocessed ?? 0,
    oldestWebhookSince: asDate(hooks[0]?.oldest),
    lastRollupAt: rollup[0]?.computedAt ?? null,
    lastRollupDay: rollup[0]?.day ?? null,
  };
}

export type HourBucket = { hour: number; inbound: number; outbound: number };

/**
 * Message volume through the day, in hourly buckets.
 *
 * The shape of a working day — where the peak is, and whether it has arrived
 * yet — which is what a supervisor deciding on cover needs and what a nightly
 * total can never show. Bounded to today's messages.
 */
export async function todayByHour(zone: string, now: Date = new Date()): Promise<HourBucket[]> {
  const local = DateTime.fromJSDate(now, { zone });
  const from = local.startOf('day').toJSDate();

  const rows = await db
    .select({
      hour: sql<number>`extract(hour from ${messages.createdAt} at time zone ${zone})::int`,
      inbound: sql<number>`count(*) filter (where ${messages.direction} = 'inbound')::int`,
      outbound: sql<number>`count(*) filter (where ${messages.direction} = 'outbound')::int`,
    })
    .from(messages)
    // Joined only to reach the channel. This is the one figure on the page
    // counted from messages rather than tickets, so it needs the exclusion
    // spelled out rather than inherited from `liveTickets` — and it needs it
    // most: the bot's traffic outnumbers the team's several hundred to one, and
    // the shape of its day is not the shape of theirs.
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        gte(messages.createdAt, from),
        lt(messages.createdAt, now),
        ne(messages.kind, 'note'),
        notInArray(conversations.channel, readOnlyChannels()),
        // A copied chat history's last day lands with today's timestamps, and
        // is not today's traffic.
        ne(messages.sourceSystem, 'import'),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byHour = new Map(rows.map((row) => [Number(row.hour), row]));

  // Every hour up to now, including the quiet ones: a gap in a bar chart reads
  // as "no data" when what it means is "nothing happened", and at 3am versus
  // 3pm those are very different things.
  return Array.from({ length: Math.min(local.hour + 1, 24) }, (_, hour) => ({
    hour,
    inbound: byHour.get(hour)?.inbound ?? 0,
    outbound: byHour.get(hour)?.outbound ?? 0,
  }));
}
