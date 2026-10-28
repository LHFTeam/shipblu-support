import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  channels,
  conversationEvents,
  conversations,
  groups,
  routingDecisions,
  ticketCategories,
} from '@/db/schema';
import { runAutomations } from '@/lib/automations';
import { logger } from '@/lib/log';
import { enqueue } from '@/lib/queue';
import { afterRoutingChanged } from '@/lib/sla';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { afterHoldEnded } from './after-hold';
import { decide, type DecidedOutcome } from './decide';
import { endHoldOnRow } from './end-hold';
import { routingModeOf } from './mode';
import { SETTLE_ROUTING_PRIORITY } from './start';

const log = logger('routing');

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The router's decision, made once per ticket in two phases with the rules in
 * between (`plans/ticket-category-routing.md`, decision 5).
 *
 * 1. **Under the row lock**, `decide` answers and this writes it: the group
 *    move if there is one, the decision row and the `routed` event. The
 *    ticket's `routing_decided_at` stays null, so it is still held.
 * 2. **The `on_update` rules run**, after every decision on a ticket that
 *    carries a category, wherever the decision left it (`rulesOwed`). Nothing
 *    can assign in between, because the ticket is still held — a rule's move
 *    in this pass does not end the hold, as one before phase one would
 *    (`endHold`) — so "sales on the merchant number goes to Merchant Care",
 *    and any rule keyed on the category, decide before anybody is handed the
 *    ticket. It is the pass the category's writer gave up on a held ticket
 *    (Jev, a person), so a ticket released or found taken owes it too; one
 *    with no category has nothing for it to react to, and its hold ends in
 *    phase one.
 * 3. **Under the lock again**, the hold ends; once that commits, the SLA policy
 *    is chosen again (`afterRoutingChanged`) with whether this decision moved
 *    the group, so a move the policy survives is still re-timed on the new
 *    team's hours.
 * 4. **The ticket is assigned and the held out-of-hours reply goes**, in the
 *    group the rules left it in and on that group's calendar.
 *
 * That is the creation pass's own order — rules, SLA, assignment, reply — and
 * the other way round leaves a Sales agent holding a Merchant Care ticket:
 * `assign_group` never touches an assignee, and `auto_assign` answers
 * `already_assigned` before it moves anything.
 *
 * Each phase is its own transaction, never one holding the row across the
 * next: the rules, the SLA and assignment take the row's lock themselves, on
 * connections of their own, and would wait on this one until Supavisor killed
 * it (§6.91). A process that dies between phases one and three leaves the hold
 * in place, and `settle_routing` completes the decision.
 */

/** Who or what is deciding — a person, Jev, a rule's pass, or the window's end. */
export type RoutingActor = { agentId?: string | null; label: string };

/** How long a phase one belongs to the caller still running it. */
export const PHASE_ONE_RESUME_MS = 60_000;

type PhaseOne = {
  outcome: DecidedOutcome;
  /** Whether phase one moved the ticket to its category's route group. */
  moved: boolean;
  /** Whether the ticket carries a category, which re-selects the SLA policy. */
  categorySettled: boolean;
  /** Whether the `on_update` rules run before the hold ends — phase two. */
  rulesOwed: boolean;
  messageId: string | null;
};

type Step =
  | { kind: 'none' }
  | { kind: 'shadow'; outcome: DecidedOutcome }
  | { kind: 'in_flight'; phaseOneAt: Date }
  | ({ kind: 'decided' } & PhaseOne);

/** What `routeNow` and `settleRouting` did, for the caller and its tests. */
export type RouteResult = Step['kind'] | 'requeued' | 'failed';

/**
 * Decide now, on a ticket whose routing is undecided: the creation pass with a
 * category already settled, Jev's answer on a held ticket, a person's category
 * edit during the hold. Answers `none` where there is nothing to decide —
 * never routed, or decided already, which is how a late answer finds a ticket
 * the window's end settled and leaves it where it is — and `in_flight` where
 * another caller's phase one already wrote the decision and is finishing it.
 *
 * On a shadow row it records the would-be decision and nothing else, and the
 * caller carries on as though routing did not exist.
 *
 * Best-effort, like the lifecycle steps that call it: a failure is logged and
 * answers `failed`, the hold stays, and `settle_routing` decides at the
 * window's end.
 */
export async function routeNow(
  conversationId: string,
  actor: RoutingActor,
  now: Date = new Date(),
): Promise<RouteResult> {
  try {
    const step = await db.transaction((tx) => phaseOne(tx, conversationId, actor, now, false));
    if (step.kind === 'decided') await finish(conversationId, step, now);
    return step.kind;
  } catch (error) {
    log.error(`could not route ${conversationId}`, error);
    return 'failed';
  }
}

/**
 * The window's end, by definition: decide whatever is there, settled category
 * or not (`fallback`), live or shadow. Also completes a decision another caller
 * wrote and then died on — one whose phase one is more than a minute old. A
 * younger one belongs to a caller still running, so this looks again once the
 * minute is up rather than racing it.
 */
export async function settleRouting(
  conversationId: string,
  now: Date = new Date(),
): Promise<RouteResult | 'gone'> {
  const step = await db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!exists) return 'gone' as const;
    return phaseOne(tx, conversationId, { label: SETTLE_ACTOR }, now, true);
  });
  if (step === 'gone') return 'gone';

  if (step.kind === 'in_flight') {
    // Without a key: the first job's key is spent for good, and this is the
    // same work legitimately asked for again (AGENTS.md, Background work).
    await enqueue(
      'settle_routing',
      { conversationId },
      {
        runAt: new Date(step.phaseOneAt.getTime() + PHASE_ONE_RESUME_MS + 1_000),
        priority: SETTLE_ROUTING_PRIORITY,
      },
    );
    return 'requeued';
  }
  if (step.kind === 'decided') await finish(conversationId, step, now);
  return step.kind;
}

/** The label a decision made at the window's end carries. */
export const SETTLE_ACTOR = 'settle_routing';

async function phaseOne(
  tx: Tx,
  conversationId: string,
  actor: RoutingActor,
  now: Date,
  resume: boolean,
): Promise<Step> {
  // The ticket first, then its routing row: the order every writer here and
  // `endHold` take them in, so two of them never wait on each other.
  // The status through a subquery and never a join, which under this lock
  // drops the row when a writer changes the status meanwhile (§ status-category).
  const [ticket] = await tx
    .select({
      channelId: conversations.channelId,
      groupId: conversations.groupId,
      categoryId: conversations.categoryId,
      assigneeAgentId: conversations.assigneeAgentId,
      statusId: conversations.statusId,
      statusCategory: statusCategoryOf(),
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .for('update');
  if (!ticket) return { kind: 'none' };

  const [row] = await tx
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId))
    .for('update');
  if (!row || row.stage === 'decided') return { kind: 'none' };

  if (row.phaseOneAt) {
    if (!resume || now.getTime() - row.phaseOneAt.getTime() < PHASE_ONE_RESUME_MS) {
      return { kind: 'in_flight', phaseOneAt: row.phaseOneAt };
    }
    // The caller that wrote it is gone. Its decision stands; what it owed is
    // finished from what it wrote.
    log.warn(
      `completing an interrupted decision conversation=${conversationId} outcome=${row.outcome ?? 'none'}`,
    );
    const outcome = (row.outcome ?? 'fallback') as DecidedOutcome;
    return {
      kind: 'decided',
      outcome,
      moved: outcome === 'category',
      categorySettled: row.categoryId !== null,
      rulesOwed: row.categoryId !== null && outcome !== 'not_open',
      messageId: row.messageId,
    };
  }

  const statusCategory = await lockedStatusCategory(tx, ticket);
  const [channel] = ticket.channelId
    ? await tx
        .select({ type: channels.type, config: channels.config, routingMode: channels.routingMode })
        .from(channels)
        .where(eq(channels.id, ticket.channelId))
    : [];
  const [category] = ticket.categoryId
    ? await tx
        .select({
          routeGroupId: ticketCategories.routeGroupId,
          key: ticketCategories.key,
          labelEn: ticketCategories.labelEn,
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, ticket.categoryId))
    : [];

  const decision = decide({
    shadow: row.shadow,
    assigneeAgentId: ticket.assigneeAgentId,
    statusCategory,
    deletedAt: ticket.deletedAt,
    isSpam: ticket.isSpam,
    mergedIntoId: ticket.mergedIntoId,
    mode: channel ? routingModeOf(channel) : 'default_group',
    groupId: ticket.groupId,
    categoryId: ticket.categoryId,
    routeGroupId: category?.routeGroupId ?? null,
  });

  const categorySettled = ticket.categoryId !== null;
  // Nothing is owed a ticket nobody may work, and its hold simply ends.
  const rulesOwed = categorySettled && decision.outcome !== 'not_open';
  const probability = categorySettled ? await categoryProbability(tx, conversationId) : null;
  const recorded = {
    outcome: decision.outcome,
    toGroupId: decision.toGroupId,
    categoryId: ticket.categoryId,
    probability,
    decidedByAgentId: actor.agentId ?? null,
    decidedByLabel: actor.label,
  };

  if (row.shadow) {
    await tx
      .update(routingDecisions)
      .set({ ...recorded, stage: 'decided', decidedAt: now })
      .where(eq(routingDecisions.id, row.id));
    return { kind: 'shadow', outcome: decision.outcome };
  }

  const moved =
    decision.outcome === 'category' &&
    (await moveToGroupIfElsewhere(conversationId, decision.toGroupId, {
      executor: tx,
      groupMustExist: true,
    }));

  // A ticket with no category has no rules to wait for, so the hold ends with
  // the decision, in this transaction.
  const endsNow = !rulesOwed;
  await tx
    .update(routingDecisions)
    .set({
      ...recorded,
      phaseOneAt: now,
      stage: endsNow ? 'decided' : 'holding',
      ...(endsNow ? { decidedAt: now } : {}),
    })
    .where(eq(routingDecisions.id, row.id));
  if (endsNow) await endHoldOnRow(tx, conversationId, now);

  const [fromGroup] = row.fromGroupId
    ? await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, row.fromGroupId))
    : [];
  const [toGroup] = decision.toGroupId
    ? await tx.select({ name: groups.name }).from(groups).where(eq(groups.id, decision.toGroupId))
    : [];

  // One per live decision, including one that moved nothing: "why is this
  // ticket in Sales?" and "why did it stay where it arrived?" both deserve an
  // answer on the page. Group and category names frozen as they were, as
  // `category_changed` freezes its label.
  await tx.insert(conversationEvents).values({
    conversationId,
    type: 'routed',
    actorAgentId: null,
    actorLabel: 'routing',
    data: {
      outcome: decision.outcome,
      by: actor.label,
      from: row.fromGroupId,
      fromName: fromGroup?.name ?? null,
      to: decision.toGroupId,
      toName: toGroup?.name ?? null,
      moved,
      ...(categorySettled && category
        ? { categoryId: ticket.categoryId, key: category.key, label: category.labelEn }
        : {}),
      ...(probability !== null ? { probability } : {}),
    },
  });

  if (endsNow && decision.outcome === 'not_open') return { kind: 'none' };
  return {
    kind: 'decided',
    outcome: decision.outcome,
    moved,
    categorySettled,
    rulesOwed,
    messageId: row.messageId,
  };
}

/**
 * Phases two to four, after phase one committed. Best-effort from here, like
 * every lifecycle step: the decision is written, and a throw would only fail
 * the job or the ingest that called this and run everything again.
 */
async function finish(conversationId: string, step: PhaseOne, now: Date): Promise<void> {
  if (step.rulesOwed) {
    await runAutomations('on_update', conversationId);
    try {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('update');
        await tx
          .update(routingDecisions)
          .set({
            stage: 'decided',
            decidedAt: sql`coalesce(${routingDecisions.decidedAt}, ${now.toISOString()}::timestamptz)`,
          })
          .where(eq(routingDecisions.conversationId, conversationId));
        await endHoldOnRow(tx, conversationId, now);
      });
    } catch (error) {
      // The hold stays until the grace runs out, and settle_routing completes
      // the decision before then.
      log.error(`could not end the hold on ${conversationId}`, error);
      return;
    }
  }

  await afterRoutingChanged(conversationId, {
    category: step.categorySettled,
    group: step.moved,
  });
  await afterHoldEnded(conversationId, step.messageId, now);
}

/** Jev's probability, when the category on the ticket is Jev's answer. */
async function categoryProbability(tx: Tx, conversationId: string): Promise<number | null> {
  const [latest] = await tx
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversationId),
        eq(conversationEvents.type, 'category_changed'),
      ),
    )
    .orderBy(desc(conversationEvents.createdAt))
    .limit(1);
  const probability = latest?.data.probability;
  return typeof probability === 'number' ? probability : null;
}
