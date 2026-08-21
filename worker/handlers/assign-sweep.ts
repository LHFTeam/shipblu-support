import { and, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  conversationEvents,
  conversationWatchers,
  conversations,
  groups,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { HEARTBEAT_TTL_MS } from '@/lib/assignment/eligibility';
import { openBacklog } from '@/lib/tickets/backlog';

/**
 * The unassigned queue, drained. Cron, every five minutes, alongside the SLA
 * sweep; also on demand when an agent comes online.
 *
 * Assignment on arrival cannot be the whole story, because most of the reasons a
 * ticket goes unassigned resolve themselves later and none of them tell anybody
 * when they do: the team was offline, the office was shut, everybody was at
 * capacity, nobody held the skill. A sweep asks the question again, and the
 * question is cheap — `assignConversation` returns without a write for a ticket
 * that already has somebody.
 *
 * Three passes, deliberately in this order. Reclaiming before assigning means a
 * ticket taken back from somebody who has gone home is placed on the same run
 * rather than sitting unassigned until the next one.
 */
export async function assignSweep(): Promise<void> {
  const now = new Date();

  const reclaimed = await reclaimAbandoned(now);
  const assigned = await assignWaiting();
  const escalated = await escalateStale();

  console.log(
    `[assign_sweep] reclaimed=${reclaimed} assigned=${assigned} escalated=${escalated}`,
  );
}

/** Groups that hand tickets out on their own. Nothing runs for a manual group. */
function routingGroups() {
  return ne(groups.assignmentStrategy, 'manual');
}

/**
 * Every unassigned ticket in a routing group gets another attempt.
 *
 * Bounded to the open backlog, so this is the queue an agent would be looking
 * at, not the archive. Each ticket is attempted individually rather than in one
 * transaction: they contend for the same group lock, and one ticket that cannot
 * be placed must not roll back the twenty before it.
 */
async function assignWaiting(): Promise<number> {
  const waiting = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(groups, eq(groups.id, conversations.groupId))
    .where(and(isNull(conversations.assigneeAgentId), routingGroups(), openBacklog()))
    // Oldest first: the queue drains in the order it filled, and a burst that
    // exceeds the team's capacity leaves the newest waiting rather than the
    // ticket that has already been waiting longest.
    .orderBy(sql`${conversations.createdAt} asc`)
    .limit(500);

  let assigned = 0;

  for (const row of waiting) {
    try {
      const outcome = await assignConversation(row.id, { actorLabel: 'assign_sweep' });
      if (outcome.assignedTo) assigned += 1;
    } catch (error) {
      // One bad ticket must not end the sweep for the rest of the queue.
      console.error(`[assign_sweep] could not assign conversation ${row.id}`, error);
    }
  }

  return assigned;
}

/**
 * Take an unanswered ticket back off somebody who is no longer here.
 *
 * Opt-in per group, off everywhere by default, and hedged in three ways that
 * matter more than the feature does:
 *
 * - **Only a ticket still awaiting its first agent reply.** Once an agent has
 *   answered, the thread is theirs; pulling it out from under a half-written
 *   follow-up is worse for the customer than a slow response, and it makes the
 *   ticket's history read as though two people handled it when one did.
 * - **Only an `open` one.** A `pending` ticket is waiting on the customer, not
 *   on us, and reclaiming it would put work in the queue that has nothing for
 *   anybody to do.
 * - **Only after the configured wait.** An agent whose train went into a tunnel
 *   is offline for ninety seconds.
 */
async function reclaimAbandoned(now: Date): Promise<number> {
  const stale = new Date(now.getTime() - HEARTBEAT_TTL_MS);

  const abandoned = await db
    .select({
      id: conversations.id,
      assigneeAgentId: conversations.assigneeAgentId,
      reclaimAfterMins: groups.reclaimAfterMins,
      assignedAt: conversations.assignedAt,
      lastSeenAt: agents.lastSeenAt,
      presence: agents.presence,
      isAcceptingTickets: agents.isAcceptingTickets,
      isActive: agents.isActive,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(groups, eq(groups.id, conversations.groupId))
    .innerJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(
      and(
        isNotNull(conversations.assigneeAgentId),
        isNotNull(groups.reclaimAfterMins),
        routingGroups(),
        eq(ticketStatuses.category, 'open'),
        // Still owes the customer a first answer.
        or(
          isNull(conversations.lastAgentMessageAt),
          lt(conversations.lastAgentMessageAt, conversations.lastCustomerMessageAt),
        ),
        openBacklog(),
      ),
    )
    .limit(500);

  let reclaimed = 0;

  for (const row of abandoned) {
    const waitMs = (row.reclaimAfterMins ?? 0) * 60_000;

    // Away counts as away. An agent who switched themselves off is as
    // unavailable as one who closed the laptop, and their unanswered tickets
    // should go back to the queue either way.
    const heartbeat = row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0;
    const gone =
      !row.isActive ||
      !row.isAcceptingTickets ||
      row.presence !== 'online' ||
      heartbeat < stale.getTime();
    if (!gone) continue;

    // Measured from the later of "they went quiet" and "they were given it", so
    // a ticket assigned to somebody who was already offline still waits the full
    // period before being taken back.
    const goneSince = Math.max(heartbeat, row.assignedAt ? new Date(row.assignedAt).getTime() : 0);
    if (now.getTime() - goneSince < waitMs) continue;

    await db.transaction(async (tx) => {
      const cleared = await tx
        .update(conversations)
        .set({ assigneeAgentId: null, assignedAt: null })
        // Re-checked in the write: the agent may have come back and replied
        // between this loop reading the row and reaching it.
        .where(
          and(
            eq(conversations.id, row.id),
            eq(conversations.assigneeAgentId, row.assigneeAgentId as string),
          ),
        )
        .returning({ id: conversations.id });

      if (cleared.length === 0) return;

      await tx.insert(conversationEvents).values({
        conversationId: row.id,
        type: 'assignment_reclaimed',
        actorLabel: 'assign_sweep',
        data: { from: row.assigneeAgentId, afterMins: row.reclaimAfterMins },
      });
    });

    reclaimed += 1;
  }

  return reclaimed;
}

/**
 * A ticket nobody has picked up for too long gets a supervisor's attention.
 *
 * This finally reads `groups.escalate_to_agent_id` and `escalate_after_mins`,
 * which have been in the schema since the first migration with a comment saying
 * exactly this and no code behind them.
 *
 * What escalation means here is what it means in the SLA sweep: the named agent
 * becomes a watcher and the timeline says why. There is still no agent
 * notification channel in this product, and inventing a quieter one for this
 * feature would leave two things to change when notifications land. The event
 * row is the idempotency key, exactly as it is there — without it, a ticket that
 * stays unassigned over a weekend escalates five hundred times.
 *
 * The age test is `now()` in SQL rather than a JavaScript timestamp so the
 * interval is built from the group's own column — one predicate for every group,
 * whatever each one's threshold is.
 */
async function escalateStale(): Promise<number> {
  const stale = await db
    .select({
      id: conversations.id,
      escalateToAgentId: groups.escalateToAgentId,
      escalateAfterMins: groups.escalateAfterMins,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(groups, eq(groups.id, conversations.groupId))
    .where(
      and(
        isNull(conversations.assigneeAgentId),
        isNotNull(groups.escalateToAgentId),
        isNotNull(groups.escalateAfterMins),
        sql`${conversations.createdAt} < now() - make_interval(mins => ${groups.escalateAfterMins})`,
        openBacklog(),
      ),
    )
    .limit(500);

  if (stale.length === 0) return 0;

  const already = await db
    .select({ conversationId: conversationEvents.conversationId })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.type, 'assignment_escalated'),
        inArray(
          conversationEvents.conversationId,
          stale.map((row) => row.id),
        ),
      ),
    );

  const escalatedBefore = new Set(already.map((row) => row.conversationId));
  let escalated = 0;

  for (const row of stale) {
    if (escalatedBefore.has(row.id)) continue;
    const agentId = row.escalateToAgentId;
    if (!agentId) continue;

    await db
      .insert(conversationWatchers)
      .values({ conversationId: row.id, agentId })
      .onConflictDoNothing();

    await db.insert(conversationEvents).values({
      conversationId: row.id,
      type: 'assignment_escalated',
      actorLabel: 'assign_sweep',
      data: { to: agentId, afterMins: row.escalateAfterMins },
    });

    escalated += 1;
  }

  return escalated;
}

