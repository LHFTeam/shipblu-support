import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversationWatchers,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import { liveTicketsFilter, loadPolicies, type LoadedPolicy } from '@/lib/sla';

/**
 * Flags SLA breaches and runs escalations. Cron, every five minutes.
 *
 * A sweep rather than a scheduled job per ticket: due dates move — a status
 * that stops the clock, a reassignment, a policy edit — and a queue full of
 * timers that each encode a due date computed hours ago is a queue full of
 * wrong answers. Re-reading the current due date every five minutes is both
 * simpler and correct, and five minutes is the resolution the schedule was
 * provisioned with.
 *
 * Idempotent by construction: the breach flags are the record of what has
 * already been reported, and escalations are keyed on an event row. Running it
 * twice in the same minute changes nothing the second time.
 */
export async function slaSweep(): Promise<void> {
  const now = new Date();
  const policies = await loadPolicies();
  const byId = new Map(policies.map((policy) => [policy.id, policy]));

  const breaches = await findBreaches(now);

  let firstResponse = 0;
  let resolution = 0;
  let escalated = 0;

  for (const row of breaches) {
    const policy = row.slaPolicyId ? byId.get(row.slaPolicyId) : undefined;

    if (row.firstResponseOverdue) {
      await recordBreach(row.id, 'first_response', row.firstResponseDueAt, now);
      firstResponse += 1;
      escalated += await escalate(row.id, policy, 'first_response', row.firstResponseDueAt, now);
    }

    if (row.resolutionOverdue) {
      await recordBreach(row.id, 'resolution', row.resolutionDueAt, now);
      resolution += 1;
      escalated += await escalate(row.id, policy, 'resolution', row.resolutionDueAt, now);
    }
  }

  console.log(
    `[sla_sweep] first_response=${firstResponse} resolution=${resolution} escalated=${escalated}`,
  );
}

type BreachRow = {
  id: string;
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstResponseOverdue: boolean;
  resolutionOverdue: boolean;
};

async function findBreaches(now: Date): Promise<BreachRow[]> {
  const overdueFirstResponse = and(
    isNotNull(conversations.firstResponseDueAt),
    lt(conversations.firstResponseDueAt, now),
    isNull(conversations.firstRespondedAt),
    eq(conversations.firstResponseBreached, false),
  )!;

  const overdueResolution = and(
    isNotNull(conversations.resolutionDueAt),
    lt(conversations.resolutionDueAt, now),
    isNull(conversations.resolvedAt),
    eq(conversations.resolutionBreached, false),
  )!;

  const rows = await db
    .select({
      id: conversations.id,
      slaPolicyId: conversations.slaPolicyId,
      firstResponseDueAt: conversations.firstResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
      firstResponseOverdue: sql<boolean>`(${overdueFirstResponse})`,
      resolutionOverdue: sql<boolean>`(${overdueResolution})`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(liveTicketsFilter(), or(overdueFirstResponse, overdueResolution)));

  return rows;
}

async function recordBreach(
  conversationId: string,
  kind: 'first_response' | 'resolution',
  dueAt: Date | null,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set(
        kind === 'first_response' ? { firstResponseBreached: true } : { resolutionBreached: true },
      )
      .where(eq(conversations.id, conversationId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'sla_breached',
      actorLabel: 'sla_sweep',
      data: {
        kind,
        dueAt: dueAt?.toISOString() ?? null,
        breachedBySeconds: dueAt ? Math.round((now.getTime() - dueAt.getTime()) / 1000) : null,
      },
    });
  });
}

/**
 * Escalation, `afterMins` after the target was missed.
 *
 * Escalating means putting the named agents on the ticket as watchers and
 * saying so in the timeline. There is no agent notification channel in the
 * product yet, so this is the honest version: the ticket appears in the
 * escalation contacts' watched list and the reason is on the record. When
 * notifications land, this is the one place that needs to also send one.
 *
 * Returns 1 when an escalation was recorded, so the sweep's log line counts
 * escalations rather than watcher rows — agents who already watched the ticket
 * would otherwise make a real escalation report as zero.
 */
async function escalate(
  conversationId: string,
  policy: LoadedPolicy | undefined,
  kind: 'first_response' | 'resolution',
  dueAt: Date | null,
  now: Date,
): Promise<number> {
  const rule =
    kind === 'first_response'
      ? policy?.escalations?.firstResponse
      : policy?.escalations?.resolution;
  if (!rule?.agentIds?.length || !dueAt) return 0;

  const escalateAt = dueAt.getTime() + (rule.afterMins ?? 0) * 60_000;
  if (now.getTime() < escalateAt) return 0;

  // The event row is the idempotency key: without it every five-minute sweep
  // would re-escalate the same ticket for as long as it stays overdue.
  const already = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'sla_escalated'),
        sql`${conversationEvents.data}->>'kind' = ${kind}`,
      ),
    )
    .limit(1);

  if (already[0]) return 0;

  await db
    .insert(conversationWatchers)
    .values(rule.agentIds.map((agentId) => ({ conversationId, agentId })))
    .onConflictDoNothing();

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'sla_escalated',
    actorLabel: 'sla_sweep',
    data: { kind, agentIds: rule.agentIds, afterMins: rule.afterMins ?? 0 },
  });

  return 1;
}
