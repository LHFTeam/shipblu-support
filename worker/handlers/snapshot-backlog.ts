import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentBacklogSnapshots, agents, conversations, ticketStatuses } from '@/db/schema';
import { openBacklog } from '@/lib/tickets/backlog';

/**
 * What each agent is holding, sampled hourly.
 *
 * "Conversations open at day end" is the one figure on the productivity report
 * that cannot be computed after the fact. `conversations` carries the current
 * status and the current assignee and nothing else, so asking it next week what
 * somebody was holding last Tuesday returns today's answer wearing last
 * Tuesday's date. Replaying the event log instead would be expensive and still
 * wrong: imported tickets have no events at all, so their backlog would simply
 * be missing rather than visibly missing.
 *
 * Hourly rather than once at the day boundary for two reasons. Render's cron
 * schedules are UTC and Cairo observes DST again, so a fixed "23:55" cron is on
 * the wrong side of midnight for half the year — with hourly samples the rollup
 * picks the one nearest the boundary *in the reporting zone* and is right either
 * way. And the intraday samples are worth having on their own: they are the only
 * record of how much an agent was carrying at the busiest point of their day
 * rather than at the tidiest.
 *
 * Never rewritten, by anything. The nightly rollup reads these; if it owned them
 * its delete-and-rebuild would destroy the only copy of a measurement that
 * cannot be taken twice.
 */
export async function snapshotBacklog(): Promise<void> {
  const at = new Date();

  // Same `openBacklog()` the dashboard and the inbox use, so a snapshot and the
  // live "holding seven tickets" cannot disagree. Not the narrower
  // `capacityBacklog()`: a cap ignores pending tickets, and a backlog history
  // that did the same would under-report what the team was carrying.
  const live = db
    .select({
      assigneeAgentId: conversations.assigneeAgentId,
      category: ticketStatuses.category,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      lastAgentMessageAt: conversations.lastAgentMessageAt,
      breached:
        sql<boolean>`(${conversations.firstResponseBreached} or ${conversations.resolutionBreached})`.as(
          'breached',
        ),
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(openBacklog())
    .as('live');

  const awaiting = sql`${live.lastCustomerMessageAt} is not null
    and (${live.lastAgentMessageAt} is null
      or ${live.lastAgentMessageAt} < ${live.lastCustomerMessageAt})`;

  // Left joined from `agents`, so somebody holding nothing gets a row of zeros
  // rather than no row. A missing row and an empty queue are the same shape in
  // a report, and only one of them means the agent finished their work.
  const rows = await db
    .select({
      agentId: agents.id,
      openCount: sql<number>`count(*) filter (where ${live.category} = 'open')::int`,
      pendingCount: sql<number>`count(*) filter (where ${live.category} = 'pending')::int`,
      awaitingReplyCount: sql<number>`count(*) filter (where ${awaiting})::int`,
      breachedCount: sql<number>`count(*) filter (where ${live.breached})::int`,
    })
    .from(agents)
    .leftJoin(live, eq(live.assigneeAgentId, agents.id))
    .where(eq(agents.isActive, true))
    .groupBy(agents.id);

  if (rows.length === 0) {
    console.log('[snapshot_backlog] no active agents');
    return;
  }

  await db.insert(agentBacklogSnapshots).values(rows.map((row) => ({ ...row, at })));

  const held = rows.reduce((running, row) => running + row.openCount + row.pendingCount, 0);
  console.log(`[snapshot_backlog] ${rows.length} agent(s), ${held} ticket(s) held`);
}
