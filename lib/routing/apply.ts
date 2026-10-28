import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { afterHoldEnded } from './after-hold';
import { decide, isWorkable, type DecidedOutcome } from './decide';
import { endHoldOnRow } from './end-hold';
import { ROUTING_GRACE_MS } from './hold';
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
 * 2. **The `on_update` rules run, once**, after every decision on a ticket
 *    that carries a category, wherever the decision left it (`PhaseOne.rules`).
 *    Nothing can assign in between, because the ticket is still held — neither
 *    a rule's move in this pass nor a person's write meanwhile ends the hold,
 *    as either would before phase one (`endHold`) — so "sales on the merchant
 *    number goes to Merchant Care", and any rule keyed on the category,
 *    decide before anybody is handed the ticket. It is the pass the
 *    category's writer gave up on a held ticket (Jev, a person), so a ticket
 *    released or found taken owes it too; one with no category has nothing
 *    for it to react to, and its hold ends in phase one. It runs on the
 *    category phase one decided on, and only on a ticket somebody may still
 *    work (`claimRules`).
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
 * it (§6.91). A process that dies between phases one and three, a claim on
 * phase two that fails, or a phase three that fails, leaves the hold in place,
 * and `settle_routing` completes the decision: the window's own job, when the
 * caller was anything else, and the job retrying itself when it was the caller
 * (`settleRouting`).
 *
 * Once phase one has committed, the decision is the router's to finish,
 * whoever acts meanwhile. A person's write in the gap — an agent's reply, the
 * console's group or assignee case, Hand to — stands, and ends nothing
 * (`endHold`): the router's pass still runs, phase three ends the hold, and
 * the assignment follows in whatever group the person and the rules left the
 * ticket. Ended by the person, the hold let their `afterHoldEnded` assign
 * before the rules, and a rule's `assign_group` then left a Sales agent
 * holding a Merchant Care ticket; decided by them, the row was one the
 * window's job never resumes, so a router that stalled ran its rules on a
 * ticket resolved since when it woke, and one whose claim failed lost the
 * pass for good.
 *
 * Phase two runs at most once, however many callers finish one decision. Its
 * pass is claimed before it starts (`rules_claimed_at`, one conditional
 * statement) and marked once it is over (`rules_done_at`, before phase three,
 * so a phase three that fails does not unmark it). A caller whose claim fails
 * stops there: another caller is running the rules and ends the hold after
 * them, and ending it now would let assignment beat a rule still to come. A
 * resumed decision skips a pass that is done, waits out a claim that may still
 * be running (`RULES_RUNNING_MS`), and takes an older claim for a claimant that
 * died — and then ends the hold without the rules, because a pass
 * half-applied once is a smaller harm than one applied twice: a second
 * `send_reply` reaches the customer twice, and every other action writes its
 * event again. Without the claim, every retry of a failed phase three re-ran
 * the whole pass, and a slow pass met a second one started beside it once its
 * phase one was a minute old.
 *
 * The claim is the only thing that says whether the pass is still to run, and
 * nothing decides a row whose phase one owed a pass without first claiming the
 * pass or giving it up: phase three follows the claim, and a resumed decision
 * that finds the ticket no longer work marks it claimed as it decides the row,
 * so a caller that only stalled runs nothing on a resolved or deleted ticket
 * when it wakes. The caller that wins the claim gives the pass up itself, too,
 * on a ticket nobody may work any more or one whose category has changed since
 * phase one (`claimRules`).
 *
 * Every lock this takes on the ticket's row is NO KEY UPDATE, never UPDATE:
 * it serialises against every other writer of the row just the same, and FOR
 * UPDATE would also stop every message inserted on the ticket — whose foreign
 * key takes KEY SHARE — for as long as it is held (`endHold` has the deadlock
 * that taught it).
 */

/** Who or what is deciding — a person, Jev, a rule's pass, or the window's end. */
export type RoutingActor = { agentId?: string | null; label: string };

/** How long a phase one belongs to the caller still running it. */
export const PHASE_ONE_RESUME_MS = 60_000;

/**
 * How long a claim on phase two's pass belongs to the caller that made it.
 * The hold's own grace (`ROUTING_GRACE_MS`), and for its reason: the time the
 * hold gives a job that never came before it stops protecting the order it
 * exists for. A real pass is a handful of statements whose every outbound call
 * carries a deadline, so a claim older than that is one whose process has
 * gone, and ending the hold then is the same valve the grace is. Shorter, a
 * pass that is merely slow would have its hold ended under it, and assignment
 * would beat its last rule.
 */
export const RULES_RUNNING_MS = ROUTING_GRACE_MS;

/**
 * What phase two owes: `not_owed` on a ticket with no category, whose hold
 * ended in phase one; `owed`, the pass to claim and run; `spent`, the hold's
 * end alone — the pass is done, or a claimant died part-way through it.
 */
type Rules = 'not_owed' | 'owed' | 'spent';

type PhaseOne = {
  outcome: DecidedOutcome;
  /** Whether phase one moved the ticket to its category's route group. */
  moved: boolean;
  /** Whether the ticket carries a category, which re-selects the SLA policy. */
  categorySettled: boolean;
  /** Whether the `on_update` rules run before the hold ends — phase two. */
  rules: Rules;
};

type Step =
  | { kind: 'none' }
  | { kind: 'shadow'; outcome: DecidedOutcome }
  /** Another caller is finishing the decision; `settleRouting` looks again then. */
  | { kind: 'in_flight'; lookAgainAt: Date }
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
 * A decision of `not_open` answers `none` too: it is written, and the hold
 * ended, but nothing is owed a ticket nobody may work, so to the caller there
 * was nothing to route.
 *
 * On a shadow row it records the would-be decision and nothing else, and the
 * caller carries on as though routing did not exist.
 *
 * Best-effort, like the lifecycle steps that call it: a failure is logged and
 * answers `failed`, the hold stays, and `settle_routing` decides — at the
 * window's end when phase one failed, and once phase one is a minute old when
 * the claim on phase two did, whose pass it then claims and runs. While the
 * row is undecided a `settle_routing` is always still to come: the first, or
 * the one it queued again on finding this decision in flight. Nothing a person
 * does meanwhile takes that over (`endHold`). A phase three that fails is
 * logged and answers `decided` — the decision is written — and that job
 * completes it without the rules, which have run. So does a caller that finds
 * phase two claimed by somebody else — the window's job, taking over a caller
 * that stalled a minute after its phase one: its pass reads the ticket after
 * this caller's write, so to the caller the rules are run on what it wrote,
 * and the claimant ends the hold. Or that job gave the pass up, on a ticket
 * resolved or deleted while this caller stalled, which is owed no rules at
 * all. A caller's `decided` is also all it hears when the pass is given up on
 * a category written since its phase one: that category's writer runs the
 * pass for it (`claimRules`).
 */
export async function routeNow(
  conversationId: string,
  actor: RoutingActor,
  now: Date = new Date(),
): Promise<RouteResult> {
  try {
    const step = await db.transaction((tx) => phaseOne(tx, conversationId, actor, now, false));
    // How it finished is the window's job's business, not this caller's: see
    // above.
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
 * minute is up rather than racing it; so does a phase two somebody claimed
 * less than `RULES_RUNNING_MS` ago, once that is up.
 *
 * Throws when its own phase three fails, so the job is retried. It is the one
 * caller nothing comes after: the job's key is spent once it completes, and
 * answering `decided` there left the ticket held, unassigned and unanswered
 * until the grace let the sweep take it, with the row undecided for good. The
 * retry finds phase one written and completes it once the minute is up —
 * or, retried sooner, finds it young and looks again without a key — and
 * finds the rules' pass done, so it runs them no second time.
 *
 * For that reason too it looks again when its own claim on phase two fails:
 * the claimant may be a `routeNow` that stalled past the minute, and this job
 * may be the window's own, whose key nothing else can spend again. If the
 * claimant finishes, the next look finds the row decided, as it does when
 * another run gave the pass up on a ticket nobody may work; if the claimant
 * died, the claim has aged by then and the decision is completed without the
 * rules.
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
    await lookAgain(conversationId, step.lookAgainAt);
    return 'requeued';
  }
  if (step.kind === 'decided') {
    const finished = await finish(conversationId, step, now);
    if (finished === 'held') {
      throw new Error(`the hold on ${conversationId} did not end; settle_routing retries`);
    }
    if (finished === 'claimed_elsewhere') {
      await lookAgain(conversationId, new Date(now.getTime() + RULES_RUNNING_MS + 1_000));
      return 'requeued';
    }
  }
  return step.kind;
}

/**
 * Another `settle_routing` for the ticket, at `runAt`. Without a key: the
 * first job's key is spent for good, and this is the same work legitimately
 * asked for again (AGENTS.md, Background work).
 */
async function lookAgain(conversationId: string, runAt: Date): Promise<void> {
  await enqueue('settle_routing', { conversationId }, { runAt, priority: SETTLE_ROUTING_PRIORITY });
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
  // `endHold` take them in, so two of them never wait on each other. NO KEY
  // UPDATE, for the reason in the header.
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
    .for('no key update');
  if (!ticket) return { kind: 'none' };

  const [row] = await tx
    .select()
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId))
    .for('update');
  if (!row || row.stage === 'decided') return { kind: 'none' };

  const statusCategory = await lockedStatusCategory(tx, ticket);

  if (row.phaseOneAt) {
    if (!resume || now.getTime() - row.phaseOneAt.getTime() < PHASE_ONE_RESUME_MS) {
      return {
        kind: 'in_flight',
        lookAgainAt: new Date(row.phaseOneAt.getTime() + PHASE_ONE_RESUME_MS + 1_000),
      };
    }
    // A pass claimed and not done, recently enough that its claimant may still
    // be running it. It owns phase three too, so nothing here may end the hold
    // — not even on a ticket since resolved, which a rule in that pass may
    // have resolved and a later one act on — and this looks again once the
    // claim has aged.
    if (
      row.rulesClaimedAt &&
      !row.rulesDoneAt &&
      now.getTime() - row.rulesClaimedAt.getTime() < RULES_RUNNING_MS
    ) {
      return {
        kind: 'in_flight',
        lookAgainAt: new Date(row.rulesClaimedAt.getTime() + RULES_RUNNING_MS + 1_000),
      };
    }
    // The caller that wrote it is gone. Its decision stands; what it owed is
    // finished from what it wrote — on the ticket as it is now, which may have
    // been resolved, deleted, merged or marked spam since. Such a ticket is
    // owed nothing, as a fresh decision would have found it `not_open`: its
    // `on_update` rules would otherwise run on it, and a category-keyed
    // `send_reply` reach the customer of a ticket nobody may work. The hold
    // simply ends, and the outcome phase one wrote stands.
    log.warn(
      `completing an interrupted decision conversation=${conversationId} outcome=${row.outcome ?? 'none'}`,
    );
    if (!isWorkable({ ...ticket, statusCategory })) {
      // The pass is given up as well, marked claimed in the statement that
      // decides the row. "Gone" is a minute's silence, not a death: the caller
      // may only have stalled, and when it wakes the claim is all it asks
      // (`claimRules`), the one record of whether the pass is still to run.
      // Left unclaimed here, it would find the pass owed on a decision this
      // has finished: given up again on a ticket still nobody's work, but run
      // on one reopened in between, after the hold this ends had let the
      // ticket be assigned.
      await tx
        .update(routingDecisions)
        .set({
          stage: 'decided',
          decidedAt: sql`coalesce(${routingDecisions.decidedAt}, ${now.toISOString()}::timestamptz)`,
          rulesClaimedAt: sql`coalesce(${routingDecisions.rulesClaimedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(eq(routingDecisions.id, row.id));
      await endHoldOnRow(tx, conversationId, now);
      return { kind: 'none' };
    }
    // At most once: a pass that is done is not run again, and neither is one
    // whose claimant died part-way through it. Which of its rules ran is not
    // recorded anywhere, and a pass half-applied once is a smaller harm than
    // one applied twice (the module's header).
    if (row.rulesClaimedAt && !row.rulesDoneAt) {
      log.warn(
        `ending the hold without the rules' pass, claimed and never finished conversation=${conversationId} claimed_at=${row.rulesClaimedAt.toISOString()}`,
      );
    }
    const outcome = (row.outcome ?? 'fallback') as DecidedOutcome;
    return {
      kind: 'decided',
      outcome,
      moved: outcome === 'category',
      categorySettled: row.categoryId !== null,
      // A row phase one left holding always had a category: one without has
      // its hold ended in phase one.
      rules: row.categoryId === null ? 'not_owed' : row.rulesClaimedAt ? 'spent' : 'owed',
    };
  }

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
  //
  // An `auto_assign` rule's strategy kept while the ticket was held
  // (`recordHeldAssignment`) is dropped only when this decision moves the
  // ticket. The rule said "assign here, with this strategy" about the group
  // the ticket was in: a move takes it out of that group, the override does
  // not carry to the new one, and phase two's `on_update` pass records again
  // any rule that matches the ticket where it now is. Left where it was, the
  // ticket is still in the group the rule spoke about, and the pick stands —
  // it has to, because an `on_create` rule has no later pass to ask again:
  // phase two runs `on_update` rules only, and dropping it there left every
  // held ticket on a group set to `manual` unassigned once its category
  // settled.
  const endsNow = !rulesOwed;
  await tx
    .update(routingDecisions)
    .set({
      ...recorded,
      phaseOneAt: now,
      stage: endsNow ? 'decided' : 'holding',
      ...(endsNow ? { decidedAt: now } : {}),
      ...(moved ? { heldStrategy: null, heldActorLabel: null } : {}),
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
    // Stamped as it is written, under the lock, as `endHold`'s is: a writer
    // whose category this decides on may have taken the lock after this
    // transaction began and stamped its `category_changed` the same way, and
    // the transaction's start would sort the decision before it.
    createdAt: CHANGE_STAMP,
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
    rules: rulesOwed ? 'owed' : 'not_owed',
  };
}

/**
 * Phases two to four, after phase one committed. Best-effort from here, like
 * every lifecycle step: the decision is written, and a throw would only fail
 * the job or the ingest that called this and run everything again.
 *
 * Answers `ended` once the hold is over and its follow-ups have run — none on
 * a ticket nobody may work, which is owed the hold's end and nothing more;
 * `held` when phase three failed, and then nothing after it has run; and
 * `claimed_elsewhere` when another caller holds the claim on phase two, which
 * leaves it all to that caller, or the window's job gave the pass up on a
 * ticket nobody may work and decided the row without it. On the last two the
 * caller decides who completes the decision (`settleRouting`). Nobody but the
 * router decides a row once phase one has written it (`endHold`), so a person
 * writing meanwhile changes only what the pass, the hold's end and the
 * assignment find on the ticket.
 */
async function finish(
  conversationId: string,
  step: PhaseOne,
  now: Date,
): Promise<'ended' | 'held' | 'claimed_elsewhere'> {
  // Owed the hold's end and nothing more: a ticket nobody may work, as phase
  // one's `not_open` and the resumed decision's own (`phaseOne`) are.
  let followUps = true;
  if (step.rules !== 'not_owed') {
    if (step.rules === 'owed') {
      const claim = await claimRules(conversationId, now);
      if (claim === 'lost') return 'claimed_elsewhere';
      if (claim === 'run') await runAutomations('on_update', conversationId);
      if (claim === 'not_workable') followUps = false;
    }
    try {
      // Marked done before phase three and apart from it, so a phase three
      // that fails, or a process that dies before it, leaves the retry with
      // the hold's end alone to do. A pass given up is over as well.
      if (step.rules === 'owed') {
        await db
          .update(routingDecisions)
          .set({ rulesDoneAt: now })
          .where(eq(routingDecisions.conversationId, conversationId));
      }
      await db.transaction(async (tx) => {
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .for('no key update');
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
      // The hold stays, and `settle_routing` completes the decision: the
      // window's job still to come, when the caller was anything else
      // (`routeNow`); the same job retried, when it was the caller. Either
      // way without the rules, which have run, or whose claim it finds.
      log.error(`could not end the hold on ${conversationId}`, error);
      return 'held';
    }
  }
  if (!followUps) return 'ended';

  await afterRoutingChanged(conversationId, {
    category: step.categorySettled,
    group: step.moved,
  });
  await afterHoldEnded(conversationId, now);
  return 'ended';
}

/**
 * Phase two's claim, and what the caller that wins it owes: `run`, the pass;
 * `other_category` and `not_workable`, the pass given up — claimed, never run
 * — and the hold's end; `lost`, nothing, because another caller holds the
 * claim. Each claim is one conditional statement on the pool, inside no
 * transaction: the routing row's lock is the only one it takes, so it cannot
 * close a cycle with a writer holding the ticket's.
 *
 * Losing it means another caller is running the pass and ends the hold after
 * it — ended here as well, the hold would let assignment beat a rule still to
 * come — or that the window's job gave the pass up as it finished the
 * decision, on a ticket that resolved or was deleted while this caller
 * stalled, which owes no pass at all (`phaseOne`'s resume marks it claimed).
 *
 * The pass is given up, by the caller that wins the claim, in two cases:
 *
 * - **A ticket nobody may work any more** — resolved, closed, deleted, merged
 *   or marked spam since phase one. Its rules would run on it, and a
 *   category-keyed `send_reply` reach the customer of a ticket nobody may
 *   work; a fresh decision would have found it `not_open` and owed it nothing.
 *   Asked of the ticket as it is read just before the claim, without a lock:
 *   the claim is what serialises the callers, and a ticket resolved between
 *   the read and the pass is resolved during it, as a rule may resolve one.
 * - **A category other than the one phase one decided on.** A person's edit
 *   or Jev's answer written since phase one is that writer's to pass on — the
 *   console's category case and the classifier run their own when they find
 *   this decision in flight on another category — so the router running its
 *   pass on the ticket as it now is would run the new category's rules a
 *   second time, and running it on the old one would fire rules keyed on a
 *   category the ticket no longer carries. Compared in the claim's own
 *   statement, so an edit committed before it is always seen; one landing
 *   between the claim and the engine's read of the ticket is the moment that
 *   remains, in which both passes see the new category.
 *
 * Phase three still follows a pass given up, and its follow-ups too on a
 * category written since: the decision stands, the hold must end, and the
 * policy and the assignment are owed wherever the ticket now is.
 */
async function claimRules(
  conversationId: string,
  now: Date,
): Promise<'run' | 'other_category' | 'not_workable' | 'lost'> {
  const [ticket] = await db
    .select({
      statusId: conversations.statusId,
      statusCategory: statusCategoryOf(),
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const workable = ticket
    ? isWorkable({ ...ticket, statusCategory: await lockedStatusCategory(db, ticket) })
    : false;

  const claim = (onTheDecidedCategory: boolean) =>
    db
      .update(routingDecisions)
      .set({ rulesClaimedAt: now })
      .where(
        and(
          eq(routingDecisions.conversationId, conversationId),
          isNull(routingDecisions.rulesClaimedAt),
          onTheDecidedCategory
            ? sql`${routingDecisions.categoryId} is not distinct from (select ${conversations.categoryId} from ${conversations} where ${conversations.id} = ${routingDecisions.conversationId})`
            : undefined,
        ),
      )
      .returning({ id: routingDecisions.id });

  if (workable && (await claim(true)).length > 0) return 'run';
  // Unclaimed still, but not to run: given up, in the same one statement a
  // claim is, so a caller racing this one loses it as it would lose a claim.
  if ((await claim(false)).length === 0) return 'lost';
  return workable ? 'other_category' : 'not_workable';
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
