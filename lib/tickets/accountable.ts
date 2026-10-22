import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { conversations, ticketStatuses } from '@/db/schema';
import { openBacklog } from './backlog';

/**
 * Who a ticket's SLA counts against, as SQL: the agent accountable for it —
 * the owner of the WhatsApp number it arrived on, frozen onto the ticket — and
 * whoever holds it when nobody is.
 *
 * One expression, imported by every reader that says whose breach a ticket is:
 * the per-agent slices `computeDay` stores, the live "Breached" column, the
 * hourly backlog sample and the snapshot on each `sla_breached` event. They are
 * read side by side — a dashboard showing a breach against one person and the
 * next morning's report filing it against another is a table nobody can
 * reconcile, and the person it was unfair to is the one who notices.
 *
 * The fallback is what keeps every ticket that is not on an owned number
 * exactly where it was before owners existed: email, chat, Meta and a team
 * number's tickets have no accountable agent, and count against their assignee
 * as they always did. Reassigning an owned ticket moves the assignee and not
 * this, which is the point of the column (its comment in
 * `db/schema/conversations.ts`).
 *
 * What a person is *carrying* — open, awaiting a reply, the capacity check —
 * stays on the assignee and does not come through here: that is a question
 * about whose queue the work is in, and the owner of a number does not carry a
 * ticket somebody else is working.
 */
export function accountableOrAssignee(
  t: { accountableAgentId: AnyPgColumn; assigneeAgentId: AnyPgColumn } = conversations,
): SQL<string | null> {
  return sql<string | null>`coalesce(${t.accountableAgentId}, ${t.assigneeAgentId})`;
}

/**
 * The open backlog's breached tickets, counted per the agent each counts
 * against: a subquery of one row per agent, to left join onto `agents`.
 *
 * Shared by the live board (`agentLoad`) and the hourly sample
 * (`snapshot_backlog`), so "breached" on the wall screen and in the stored
 * history are one count. A separate pass rather than a filter on the backlog
 * those two already join on the assignee, because the two keys disagree on
 * exactly the tickets this exists for — owned and held by somebody else, or
 * owned and held by nobody — and grouped once rather than counted per agent,
 * because no index serves `coalesce(...)` and a correlated count would walk the
 * whole backlog once for every agent on a page refreshed every twenty seconds.
 */
export function breachedByAccountable() {
  const agentId = accountableOrAssignee();
  return db
    .select({
      agentId: sql<string>`${agentId}`.as('breached_agent_id'),
      count: sql<number>`count(*)::int`.as('breached_count'),
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        openBacklog(),
        sql`(${conversations.firstResponseBreached} or ${conversations.resolutionBreached})`,
      ),
    )
    .groupBy(agentId)
    .as('breached_by');
}
