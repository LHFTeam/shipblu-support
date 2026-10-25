import { and, eq, exists, isNotNull, isNull, lt, not, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversationWatchers,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import { liveTicketsFilter, loadPolicies, type LoadedPolicy } from '@/lib/sla';
import { accountableOrAssignee } from '@/lib/tickets/accountable';
import { logger } from '@/lib/log';

const log = logger('sla_sweep');

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
    if (row.firstResponseOverdue) {
      await recordBreach(row.id, 'first_response', row.firstResponseDueAt, now);
      firstResponse += 1;
    }

    if (row.resolutionOverdue) {
      await recordBreach(row.id, 'resolution', row.resolutionDueAt, now);
      resolution += 1;
    }
  }

  // A second pass rather than an escalation attempt on the breach itself. The
  // breach flag takes a ticket out of `findBreaches` on the run that sets it,
  // and that run is at most five minutes after the due date — so an escalation
  // tried only there fired for a wait of under five minutes and never for the
  // twenty or sixty an admin actually sets. After the breaches, so a target
  // missed by more than its wait is still escalated on the run that finds it.
  for (const row of await findUnescalated(now)) {
    const policy = row.slaPolicyId ? byId.get(row.slaPolicyId) : undefined;

    if (row.firstResponseAwaiting) {
      escalated += await escalate(row.id, policy, 'first_response', row.firstResponseDueAt, now);
    }

    if (row.resolutionAwaiting) {
      escalated += await escalate(row.id, policy, 'resolution', row.resolutionDueAt, now);
    }
  }

  log.info(`first_response=${firstResponse} resolution=${resolution} escalated=${escalated}`);
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

type UnescalatedRow = {
  id: string;
  slaPolicyId: string | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  firstResponseAwaiting: boolean;
  resolutionAwaiting: boolean;
};

/**
 * Breaches still owed an escalation: reported, not yet escalated, and still
 * unmet. Whether the wait is over, and whether the policy escalates at all, is
 * left to `escalate`, which reads the policy the sweep already loaded.
 *
 * The same clock-running population as the breach query, so a ticket whose
 * clock stopped after the breach — resolved, or waiting on the customer — is
 * not escalated for a target it no longer has. And a first response that
 * arrived after the breach but inside the wait ends it: the escalation is for
 * a customer still waiting.
 *
 * The event row is excluded here as well as checked in `escalate`, so an
 * escalated ticket stops being read at all rather than being re-read every
 * five minutes for as long as it stays open. A breach with nothing to escalate
 * to — its policy has no rule for that kind, or it has no active policy — is
 * still read on every run until its clock stops; `escalate` returns before any
 * query for it, so what that costs is the row.
 *
 * The due dates are there for the planner, not for the answer: a breach always
 * has a due date in the past, and `escalate` refuses one that does not. Without
 * them nothing here is indexed, and the query reads every ticket ever received
 * to find the hundred or so it wants: 620 ms against production's 36,000
 * tickets, and 3 ms with the two due-date indexes that `findBreaches` uses too.
 */
async function findUnescalated(now: Date): Promise<UnescalatedRow[]> {
  const awaitingFirstResponse = and(
    isNotNull(conversations.firstResponseDueAt),
    lt(conversations.firstResponseDueAt, now),
    eq(conversations.firstResponseBreached, true),
    isNull(conversations.firstRespondedAt),
    not(escalationRecorded('first_response')),
  )!;

  const awaitingResolution = and(
    isNotNull(conversations.resolutionDueAt),
    lt(conversations.resolutionDueAt, now),
    eq(conversations.resolutionBreached, true),
    isNull(conversations.resolvedAt),
    not(escalationRecorded('resolution')),
  )!;

  return db
    .select({
      id: conversations.id,
      slaPolicyId: conversations.slaPolicyId,
      firstResponseDueAt: conversations.firstResponseDueAt,
      resolutionDueAt: conversations.resolutionDueAt,
      firstResponseAwaiting: sql<boolean>`(${awaitingFirstResponse})`,
      resolutionAwaiting: sql<boolean>`(${awaitingResolution})`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        liveTicketsFilter(),
        isNotNull(conversations.slaPolicyId),
        or(awaitingFirstResponse, awaitingResolution),
      ),
    );
}

function escalationRecorded(kind: 'first_response' | 'resolution') {
  return exists(
    db
      .select({ one: sql`1` })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversations.id),
          settlesEscalation(kind, sql`${conversations.slaPolicyId}::text`),
        ),
      ),
  );
}

/**
 * An `sla_escalated` event that settles `kind` for the policy named by
 * `policyId` (as text, which is what `->>` compares against).
 *
 * Per policy as well as per kind, because a ticket can change policy before
 * anybody answers it (`reselectPolicyBeforeFirstResponse`): escalated under
 * the default, then filed under Sales, it is owed the Sales contacts when it
 * misses Sales' target too, and keyed on the kind alone the first escalation
 * stood for both. An event written before it carried a policy names none, and
 * settles the kind under any — so no ticket escalated then is escalated again.
 * One predicate for the sweep's filter and `escalate`'s own check, so the two
 * cannot come to disagree.
 */
function settlesEscalation(kind: 'first_response' | 'resolution', policyId: SQL) {
  return and(
    eq(conversationEvents.type, 'sla_escalated'),
    sql`${conversationEvents.data}->>'kind' = ${kind}`,
    sql`(${conversationEvents.data}->>'policyId' is null or ${conversationEvents.data}->>'policyId' = ${policyId})`,
  );
}

async function recordBreach(
  conversationId: string,
  kind: 'first_response' | 'resolution',
  dueAt: Date | null,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [breached] = await tx
      .update(conversations)
      .set(
        kind === 'first_response' ? { firstResponseBreached: true } : { resolutionBreached: true },
      )
      .where(eq(conversations.id, conversationId))
      .returning({ accountableAgentId: accountableOrAssignee() });

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'sla_breached',
      actorLabel: 'sla_sweep',
      data: {
        kind,
        dueAt: dueAt?.toISOString() ?? null,
        breachedBySeconds: dueAt ? Math.round((now.getTime() - dueAt.getTime()) / 1000) : null,
        // Whom the breach counted against when it happened — the number's
        // owner, or whoever held the ticket — snapshotted as `reopened`
        // snapshots its resolver: the ticket's columns move after this (a
        // reassignment, a handover), and the event is the one record of the
        // moment that does not. Read by the update that sets the flag, so it is
        // the row the flag was set on.
        accountableAgentId: breached?.accountableAgentId ?? null,
      },
    });
  });
}

/**
 * Escalation, `afterMins` after the target was missed.
 *
 * Escalating means putting the named agents on the ticket as watchers and
 * saying so in the timeline, and emailing nobody: the ticket appears in the
 * escalation contacts' watched list and the reason is on the record. The one
 * email that tells agents about a ticket is a low rating's alert, and
 * `notify_low_rating` is the shape to copy when escalation should send one
 * too — an event naming who was to be told, and one `send_notification_email`
 * per recipient on its transaction — here and in `escalateStale`
 * (`assign-sweep.ts`) together, so the watchlist reads the same wherever a
 * ticket was escalated from.
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
  if (!policy || !rule?.agentIds?.length || !dueAt) return 0;

  const escalateAt = dueAt.getTime() + (rule.afterMins ?? 0) * 60_000;
  if (now.getTime() < escalateAt) return 0;

  // The event row is the idempotency key: without it every five-minute sweep
  // would re-escalate the same ticket for as long as it stays overdue. Per
  // policy (`settlesEscalation`).
  const already = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        settlesEscalation(kind, sql`${policy.id}`),
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
    data: { kind, policyId: policy.id, agentIds: rule.agentIds, afterMins: rule.afterMins ?? 0 },
  });

  return 1;
}
