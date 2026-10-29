import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  channels,
  contacts,
  conversationEvents,
  conversations,
  groups,
  routingDecisions,
  ticketCategories,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { activeRules, applyRules } from '@/lib/automations';
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
type Executor = typeof db | Tx;

/**
 * The router's decision, made once per ticket in two phases with the rules in
 * between (`plans/ticket-category-routing.md`, decision 5).
 *
 * 1. **Under the row lock**, `decide` answers and this writes it: the group
 *    move if there is one, the decision row and the `routed` event. The
 *    ticket's `routing_decided_at` stays null, so it is still held.
 * 2. **The `on_update` rules run**, after every decision on a ticket that
 *    carries a category, wherever the decision left it (`PhaseOne.rules`).
 *    Nothing can assign in between, because the ticket is still held — neither
 *    a rule's move in this pass nor a person's write meanwhile ends the hold,
 *    as either would before phase one (`endHold`) — so "sales on the merchant
 *    number goes to Merchant Care", and any rule keyed on the category,
 *    decide before anybody is handed the ticket. It is the pass the
 *    category's writer gave up on a held ticket (Jev, a person), so a ticket
 *    released or found taken owes it too; one with no category has nothing
 *    for it to react to, and its hold ends in phase one. It runs on the
 *    ticket as it is when the pass is claimed, and only on one somebody may
 *    still work (`phaseTwo`).
 * 3. **Under the lock again**, the hold ends — unless a writer has handed its
 *    own pass to the router since this one was claimed (`deferToRouter`), and
 *    then phase two runs again, on the ticket as that writer left it, before
 *    this is tried again. Once the hold's end commits, the SLA policy is
 *    chosen again (`afterRoutingChanged`) with whether this decision, and the
 *    writes it passed since, moved the group or changed the category, so a
 *    move the policy survives is still re-timed on the new team's hours.
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
 * whoever acts meanwhile. A person's write in the gap stands, and ends nothing
 * (`endHold`): the router's pass still runs, phase three ends the hold, and
 * the assignment follows in whatever group the person and the rules left the
 * ticket. Ended by the person, the hold let their `afterHoldEnded` assign
 * before the rules, and a rule's `assign_group` then left a Sales agent
 * holding a Merchant Care ticket; decided by them, the row was one the
 * window's job never resumes, so a router that stalled ran its rules on a
 * ticket resolved since when it woke, and one whose claim failed lost the
 * pass for good.
 *
 * Nor does a writer in the gap run an `on_update` pass of its own — the
 * console's category, group and assignee cases, Hand to, Jev's answer: it
 * re-arms the router's (`deferToRouter`), and the router's pass, run on the
 * ticket as the write left it, is the one the write is owed. Run beside the
 * router's, the writer's pass was unordered with the hold's end, so a rule in
 * it moved the ticket away from somebody the router had just handed it to; and
 * which writes a claimed pass had read was a matter of timing, so a category
 * written as the pass began was passed by the router and by its writer both.
 * An agent's reply runs no pass and re-arms nothing; a rule in the router's
 * own pass is that pass.
 *
 * Phase two runs once for every write it is owed for, and never twice for
 * one. Its pass is claimed before it starts (`rules_claimed_at`), in the
 * transaction that reads the ticket the pass then runs on, under the ticket's
 * lock — the lock every writer that re-arms it holds — so a write lands wholly
 * before the claim, and the pass reads it, or wholly after, and re-arms a pass
 * that did not. It is marked once it is over (`rules_done_at`, before phase
 * three, so a phase three that fails does not unmark it), but only while the
 * claim is still this caller's: a write re-arming it meanwhile leaves the pass
 * owed again. A caller whose claim fails stops there: another caller is
 * running the rules and ends the hold after them, and ending it now would let
 * assignment beat a rule still to come. A resumed decision skips a pass that
 * is done, waits out a claim that may still be running (`RULES_RUNNING_MS`),
 * runs one a writer re-armed, and takes an older claim for a claimant that
 * died — and then ends the hold without the rules, because a pass
 * half-applied once is a smaller harm than one applied twice: a second
 * `send_reply` reaches the customer twice, and every other action writes its
 * event again. Without the claim, every retry of a failed phase three re-ran
 * the whole pass, and a slow pass met a second one started beside it once its
 * phase one was a minute old.
 *
 * The claim is the only thing that says whether the pass is still to run, and
 * nothing decides a row whose phase one owed a pass without first claiming the
 * pass or giving it up: phase three follows the claim, and ends nothing while
 * it is cleared; and a resumed decision that finds the ticket no longer work
 * marks it claimed as it decides the row, so a caller that only stalled runs
 * nothing on a resolved or deleted ticket when it wakes. The caller that wins
 * the claim gives the pass up itself, too, on a ticket nobody may work any
 * more (`phaseTwo`).
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
 * end alone — the pass is done, or a claimant died part-way through it — under
 * the claim found on it, which phase three still asks is the row's.
 */
type Rules = { kind: 'not_owed' } | { kind: 'owed' } | { kind: 'spent'; claimedAt: Date };

/**
 * How many passes one caller runs before it ends the hold all the same. Each
 * pass after the first is owed to a write that landed during the one before
 * it, so the cap is reached only by writers arriving faster than a pass runs —
 * a person and Jev relabelling the ticket back and forth — and it is the hold
 * that has to give: kept for as long as they keep at it, a ticket nobody may
 * be handed waits on writers who are not deciding where it goes. The last
 * writer's rules are then the one pass not run, and the warning names it.
 */
const MAX_PASSES = 5;

type PhaseOne = {
  outcome: DecidedOutcome;
  /** Whether phase one moved the ticket to its category's route group. */
  moved: boolean;
  /** Whether the ticket carries a category, which re-selects the SLA policy. */
  categorySettled: boolean;
  /** What the `on_update` rules are owed before the hold ends — phase two. */
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
 * completes it without the rules, which have run, unless a writer has
 * re-armed them since. So does a caller that finds phase two claimed by
 * somebody else — the window's job, taking over a caller that stalled a minute
 * after its phase one: its pass reads the ticket after this caller's write, so
 * to the caller the rules are run on what it wrote, and the claimant ends the
 * hold. Or that job gave the pass up, on a ticket resolved or deleted while
 * this caller stalled, which is owed no rules at all.
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
 * finds the rules' pass done, so it runs them no second time: only a writer's
 * re-arming since (`deferToRouter`) leaves a pass owed, and that pass is the
 * writer's.
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
      // (`phaseTwo`), the one record of whether the pass is still to run.
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
    // one applied twice (the module's header). A pass a writer re-armed since
    // (`deferToRouter`) carries no claim, and is claimed and run like one
    // nobody had claimed — never taken for a claimant's that died, since the
    // write it is owed for came after whatever that claimant ran.
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
      rules:
        row.categoryId === null
          ? { kind: 'not_owed' }
          : row.rulesClaimedAt
            ? { kind: 'spent', claimedAt: row.rulesClaimedAt }
            : { kind: 'owed' },
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
    rules: rulesOwed ? { kind: 'owed' } : { kind: 'not_owed' },
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
 * assignment find on the ticket — and a writer with a pass of its own re-arms
 * this one (`deferToRouter`), which phase three then finds and runs again
 * before it ends anything.
 */
async function finish(
  conversationId: string,
  step: PhaseOne,
  now: Date,
): Promise<'ended' | 'held' | 'claimed_elsewhere'> {
  // A ticket with no category had its hold ended in phase one, and is owed
  // the follow-ups alone.
  if (step.rules.kind === 'not_owed') {
    await afterRoutingChanged(conversationId, {
      category: step.categorySettled,
      group: step.moved,
    });
    await afterHoldEnded(conversationId, now);
    return 'ended';
  }

  // The claim phase three asks the row still carries: this caller's own, or
  // the one a resumed decision found spent.
  let claim: Date;
  // Whether the hold's follow-ups are owed: not on a ticket nobody may work,
  // as phase one's `not_open` and the resumed decision's own (`phaseOne`) are
  // owed none — asked of the ticket as the last claim found it.
  let followUps = true;
  let passes = 0;
  let unmarked = false;
  if (step.rules.kind === 'spent') {
    claim = step.rules.claimedAt;
  } else {
    const ran = await phaseTwo(conversationId, now);
    if (ran === 'lost') return 'claimed_elsewhere';
    ({ claim, followUps } = ran);
    passes = 1;
    unmarked = true;
  }

  let ended: Extract<PhaseThree, { kind: 'ended' }>;
  for (;;) {
    let third: PhaseThree;
    try {
      // Marked done before phase three and apart from it, so a phase three
      // that fails, or a process that dies before it, leaves the retry with
      // the hold's end alone to do. A pass given up is over as well. Only
      // while the claim is this caller's: a writer that re-armed the pass
      // meanwhile has cleared it, and the pass it is owed has not run.
      if (unmarked) {
        await db
          .update(routingDecisions)
          .set({ rulesDoneAt: claim })
          .where(
            and(
              eq(routingDecisions.conversationId, conversationId),
              eq(routingDecisions.rulesClaimedAt, claim),
            ),
          );
        unmarked = false;
      }
      third = await phaseThree(conversationId, claim, now, passes >= MAX_PASSES);
    } catch (error) {
      // The hold stays, and `settle_routing` completes the decision: the
      // window's job still to come, when the caller was anything else
      // (`routeNow`); the same job retried, when it was the caller. Either
      // way without the rules, which have run, or whose claim it finds —
      // unless a writer re-arms them before it does.
      log.error(`could not end the hold on ${conversationId}`, error);
      return 'held';
    }
    if (third.kind === 'ended') {
      ended = third;
      break;
    }
    if (third.kind === 'claimed_elsewhere') return 'claimed_elsewhere';
    // Re-armed: the pass again, on the ticket as the write left it, under a
    // claim of its own — on the clock, not the caller's `now`, so the age the
    // window's job reads off it is the age of this pass.
    const ran = await phaseTwo(conversationId, new Date());
    if (ran === 'lost') return 'claimed_elsewhere';
    ({ claim, followUps } = ran);
    passes += 1;
    unmarked = true;
  }
  if (!followUps) return 'ended';

  // As phase one and every pass since left the ticket: the writes the router
  // passed in the gap skipped this call of their own, so a group a person
  // moved it to, or a category written since, is re-timed and re-selected
  // here. One the rules changed is asked again too, and finds nothing left to
  // do (`afterRoutingChanged` is a no-op when nothing would change).
  await afterRoutingChanged(conversationId, {
    category: step.categorySettled || ended.categoryChanged,
    group: step.moved || ended.groupChanged,
  });
  await afterHoldEnded(conversationId, now);
  return 'ended';
}

/** The ticket as `applyRules` takes it, read by the claim that begins the pass. */
type PassTicket = Parameters<typeof applyRules>[1];
type PassRules = Awaited<ReturnType<typeof activeRules>>;

/**
 * Phase two: the claim on the rules' pass, and the pass when it is to run.
 * Answers `lost` when another caller holds the claim, or the claim and whether
 * the hold's follow-ups are owed: not on a ticket nobody may work any more —
 * resolved, closed, deleted, merged or marked spam since phase one — whose
 * pass is given up, claimed and never run. Its rules would run on it, and a
 * category-keyed `send_reply` reach the customer of a ticket nobody may work;
 * a fresh decision would have found it `not_open` and owed it nothing.
 *
 * Losing the claim means another caller is running the pass and ends the hold
 * after it — ended here as well, the hold would let assignment beat a rule
 * still to come — or that the window's job gave the pass up as it finished the
 * decision, on a ticket that resolved or was deleted while this caller
 * stalled, which owes no pass at all (`phaseOne`'s resume marks it claimed).
 *
 * The claim and the read of the ticket the pass runs on are one transaction,
 * under the ticket's lock and then the routing row's — the order every routing
 * writer takes them in — and the pass is run on that read (`applyRules`),
 * never on one of its own. A writer that re-arms the pass holds the ticket's
 * lock from its write to its commit (`deferToRouter`), so it lands wholly
 * before this — and the pass reads it — or wholly after, re-arming a pass
 * that did not. With the claim in one statement and the pass reading the
 * ticket a few statements later, a write between them was read by the pass
 * and re-armed it too, and its rules ran twice. Nothing else holds a lock
 * across the pass, whose rules take the ticket's on connections of their own.
 *
 * With no `on_update` rule there is nothing to read the ticket for, and the
 * claim is the one conditional statement it always was, the ticket's
 * workability read without a lock beside it: no transaction and no lock, each
 * a place in the pool (§6.91), for a pass that runs nothing.
 */
async function phaseTwo(
  conversationId: string,
  at: Date,
): Promise<'lost' | { claim: Date; followUps: boolean }> {
  const rules = await activeRules('on_update');
  let pass: { rules: PassRules; ticket: PassTicket } | null = null;
  let workable: boolean;

  if (rules.length === 0) {
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
    workable = ticket
      ? isWorkable({ ...ticket, statusCategory: await lockedStatusCategory(db, ticket) })
      : false;
    if (!(await claimRules(db, conversationId, at))) return 'lost';
  } else {
    const claimed = await db.transaction(async (tx) => {
      // Locked without a join, which under a lock that waited can answer no
      // row at all (`lib/tickets/status-category.ts`); read joined once the
      // lock is held, when nothing can move the row under the read.
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('no key update');
      if (!(await claimRules(tx, conversationId, at))) return 'lost' as const;
      const [ticket] = await tx
        .select({
          conversation: conversations,
          statusCategory: ticketStatuses.category,
          requesterEmail: contacts.primaryEmail,
          formSlug: ticketForms.slug,
        })
        .from(conversations)
        .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
        .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
        .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
        .where(eq(conversations.id, conversationId));
      return ticket ?? null;
    });
    if (claimed === 'lost') return 'lost';
    workable = claimed
      ? isWorkable({ ...claimed.conversation, statusCategory: claimed.statusCategory })
      : false;
    if (claimed && workable) pass = { rules, ticket: claimed };
  }

  if (pass) {
    // Best-effort, as `runAutomations` is: a pass that throws must not take
    // the hold's end, the assignment and the held reply down with it.
    try {
      await applyRules(pass.rules, pass.ticket, new Date());
    } catch (error) {
      log.error(`the rules' pass failed on ${conversationId}`, error);
    }
  }
  return { claim: at, followUps: workable };
}

/**
 * The claim itself: one conditional statement, so a caller racing this one
 * loses it as it would lose any claim — whether the pass is then run or given
 * up, the claim is what says nobody else is to.
 */
async function claimRules(executor: Executor, conversationId: string, at: Date): Promise<boolean> {
  const claimed = await executor
    .update(routingDecisions)
    .set({ rulesClaimedAt: at })
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        isNull(routingDecisions.rulesClaimedAt),
      ),
    )
    .returning({ id: routingDecisions.id });
  return claimed.length > 0;
}

type PhaseThree =
  | { kind: 'ended'; categoryChanged: boolean; groupChanged: boolean }
  | { kind: 'rearmed' }
  | { kind: 'claimed_elsewhere' };

/**
 * Phase three: the hold's end, under the ticket's lock and then the routing
 * row's — unless the pass this caller ran, or found spent, is no longer the
 * one the row carries. Cleared, a writer re-armed it after the pass had read
 * the ticket (`deferToRouter`), and the pass is owed again: `rearmed`, and
 * nothing ends. Another caller's, it was re-armed and claimed again by them,
 * and they end the hold after their pass: `claimed_elsewhere`.
 *
 * Under the same locks every re-arming writer takes, so a write is either
 * seen here, or meets the row decided and runs its own pass, as any write
 * after the hold does: nothing lands between this read and the hold's end.
 *
 * `lastPass`: the caller has run `MAX_PASSES` passes, and a re-armed pass
 * ends the hold all the same — marked claimed and done, given up — with a
 * warning naming it.
 *
 * Answers too whether the ticket's category and group are still where phase
 * one left them, which the hold's follow-ups take.
 */
async function phaseThree(
  conversationId: string,
  claim: Date,
  now: Date,
  lastPass: boolean,
): Promise<PhaseThree> {
  return db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ groupId: conversations.groupId, categoryId: conversations.categoryId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for('no key update');
    const [row] = await tx
      .select({
        rulesClaimedAt: routingDecisions.rulesClaimedAt,
        categoryId: routingDecisions.categoryId,
        toGroupId: routingDecisions.toGroupId,
      })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, conversationId))
      .for('update');

    let givenUp = false;
    if (row && !row.rulesClaimedAt) {
      if (!lastPass) return { kind: 'rearmed' };
      log.warn(
        `ending the hold with the rules' pass re-armed again after ${MAX_PASSES} passes conversation=${conversationId}`,
      );
      givenUp = true;
    } else if (row?.rulesClaimedAt && row.rulesClaimedAt.getTime() !== claim.getTime()) {
      return { kind: 'claimed_elsewhere' };
    }

    await tx
      .update(routingDecisions)
      .set({
        stage: 'decided',
        decidedAt: sql`coalesce(${routingDecisions.decidedAt}, ${now.toISOString()}::timestamptz)`,
        ...(givenUp ? { rulesClaimedAt: now, rulesDoneAt: now } : {}),
      })
      .where(eq(routingDecisions.conversationId, conversationId));
    await endHoldOnRow(tx, conversationId, now);
    const both = ticket && row ? { ticket, row } : null;
    return {
      kind: 'ended',
      categoryChanged: both !== null && both.ticket.categoryId !== both.row.categoryId,
      groupChanged: both !== null && both.ticket.groupId !== both.row.toGroupId,
    };
  });
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
