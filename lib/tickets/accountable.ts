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
export function accountableOrAssignee(): SQL<string | null> {
  return sql<
    string | null
  >`coalesce(${conversations.accountableAgentId}, ${conversations.assigneeAgentId})`;
}

/**
 * The same answer as it stood at `at`: for the rollup, which rebuilds the last
 * three days from current state every night.
 *
 * Read from the column alone, a handover on Tuesday would re-file Monday's
 * figures — a breach answered late under the previous owner included — onto
 * the new owner when Tuesday night rebuilds Monday, which is exactly what
 * freezing the column was meant to prevent. Every write that moves it after a
 * ticket exists leaves an `accountable_changed` event naming whom it moved
 * from (`handOverNumber`, `alignAccountable`), so the value at `at` is the
 * `from` of the first such event after it, and the column itself when nothing
 * has moved it since. Only accountability is read back; the assignee half is
 * the current one, as every agent slice has always been.
 *
 * `ace` is an alias because the reopened read selects from
 * `conversation_events` itself and passes its `created_at` as `at`: aliased,
 * the inner table hides its own name, so that reference reaches the outer row.
 */
export function accountableOrAssigneeAt(at: SQL | AnyPgColumn): SQL<string | null> {
  const movedSince = sql`from conversation_events ace
    where ace.conversation_id = ${conversations.id}
      and ace.type = 'accountable_changed'
      and ace.created_at > ${at}`;
  return sql<string | null>`coalesce(
    case when exists (select 1 ${movedSince})
      then (select (ace.data->>'from')::uuid ${movedSince} order by ace.created_at, ace.id limit 1)
      else ${conversations.accountableAgentId}
    end,
    ${conversations.assigneeAgentId}
  )`;
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
