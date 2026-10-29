import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, routingDecisions } from '@/db/schema';
import { logger } from '@/lib/log';
import { loadClockInputs, type ClockInputs } from '@/lib/sla';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { isWorkable, type RoutingOutcome } from './decide';

const log = logger('routing');

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where an undecided ticket's routing stands, as `undecidedRouting` answers it. */
export type UndecidedRouting = {
  shadow: boolean;
  stage: 'pending' | 'holding';
  /**
   * Phase one is written and the hold not yet ended: a decision some caller is
   * finishing. A writer that asked `deferToRouter` first and was refused meets
   * one only on a ticket nobody may work, whose pass the router gives up.
   */
  decisionInFlight: boolean;
};

/**
 * Where a ticket's routing stands, while it is undecided: null for a ticket
 * that never entered routing and for one already decided, which every caller
 * treats alike — as a ticket routing has nothing more to say about.
 *
 * Read inside the caller's transaction when the answer decides what it does
 * next — the classifier, under the row lock its write took — because the
 * stage moves under that lock (`beginRouting`, `routeNow`), and read after the
 * commit it can already have moved.
 */
export async function undecidedRouting(
  executor: Executor,
  conversationId: string,
): Promise<UndecidedRouting | null> {
  const [row] = await executor
    .select({
      shadow: routingDecisions.shadow,
      stage: routingDecisions.stage,
      phaseOneAt: routingDecisions.phaseOneAt,
    })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    );
  if (!row) return null;
  // The WHERE has left `decided` out, so the row is one of the other two; the
  // column's type still carries all three, and the answer names only these.
  return {
    shadow: row.shadow,
    stage: row.stage === 'pending' ? 'pending' : 'holding',
    decisionInFlight: row.phaseOneAt !== null,
  };
}

/**
 * Hands a writer's own `on_update` pass to the router, when the write lands
 * while a decision is in flight: phase one has written it, and the router —
 * or `settle_routing` after it — has still to end the hold
 * (`lib/routing/apply.ts`). Answers true when it did, and the caller then runs
 * no pass of its own, nor the policy's second look, nor `routeNow`: the
 * router's pass runs again, on the ticket as this write left it, and the
 * hold's end, the policy and the assignment follow it.
 *
 * Asked by every writer with a pass of its own that can land in that gap — the
 * console's edits, Hand to, Jev's answer and the priority classifier's — in
 * its write's own transaction, once the write holds the ticket's lock. Not by
 * an agent's reply, which runs no pass; nor by a rule, whose pass is either
 * the router's own or one that read the ticket before this decision existed.
 *
 * Nor on a ticket nobody may work any more — resolved, closed, deleted, merged
 * or marked spam, by this write or before it (`isWorkable`), read under the
 * lock the write holds — where this answers false, and the writer runs its own
 * pass as an edit on any resolved ticket does. The router owes such a ticket no
 * pass, and gives its own up as it claims it (`phaseTwo`): handed to it, the
 * pass was handed to nobody, and no rule keyed on what the write changed ever
 * ran. Nothing races the writer's pass there, because the router assigns
 * nobody a ticket nobody may work. One resolved after this write re-armed the
 * pass gives it up the same way. A person's resolve runs its own pass, which
 * reads this write. A rule's resolve may come from a pass that read the ticket
 * before this write — the router's own, claimed before it — and then this
 * write's rules run nowhere: that pass was not owed them, and the one this
 * write re-armed is given up on the ticket it resolved. Accepted: a ticket the
 * rules resolved in the moment the write landed is owed nothing more, as a
 * fresh decision would find it `not_open`.
 *
 * A pass of the writer's own here would be unordered with the router's end of
 * the hold. The router assigns as soon as its last pass is over and phase
 * three has committed, so the writer's rules could run after somebody was
 * handed the ticket — and an `assign_group` among them, which never touches
 * an assignee, then left a Sales agent holding a Merchant Care ticket. Nor was
 * there a way to have the router simply wait for it: a pass the router claimed
 * read the ticket at some point the writer could not see, so a write landing
 * then was passed by both, or by neither.
 *
 * So the write re-arms the router's pass instead: its claim cleared, so that
 * phase three runs the pass again rather than ending the hold (below for what
 * becomes of the mark of done). Under the ticket's lock, which the write took
 * first, and then the routing row's, the order every routing writer takes
 * them in, this write is ordered against each of the router's steps that read
 * the ticket or end the hold, both of which take the ticket's lock too:
 *
 * - **before the router's claim**, the pass the claim begins reads this write;
 * - **after it**, the pass read the ticket before this write, and phase three,
 *   finding the claim cleared, runs it again instead of ending the hold;
 * - **after phase three**, the row is decided, this answers false, and the
 *   writer's pass is a relabel's, like any write after the hold.
 *
 * Clearing the claim does not stop the pass it was taken for: a claimant
 * part-way through its rules runs the rest of them on the ticket it read. So
 * the re-arm keeps the age of a claim still running, in `rules_done_at` — a
 * row with no claim and a done mark is a pass re-armed over a claim taken
 * then, a state nothing else writes — and `settle_routing`, resuming the
 * decision, treats it as the claim it was: left to its claimant until
 * `RULES_RUNNING_MS` is up, then run, the claimant having died, as the pass
 * this write is owed. Cleared outright, it read as no claim at all, and a
 * resume falling due during a slow pass ran a second one beside it, ended the
 * hold and assigned the ticket, and the first pass's remaining rules then moved
 * it away from the agent the resume had chosen. A claim already marked done
 * leaves nothing to wait out — its claimant has only phase three to run, which
 * ends nothing on a claim it no longer holds — so the re-arm clears its mark
 * with it, and a resume runs the pass this write is owed at once, as it did
 * before re-arming kept ages. A second re-arm before anybody claims again keeps
 * the age the first one kept: the claimant it speaks for is the same.
 *
 * A rule's pick kept for the hold's end (`recordHeldAssignment`) is not dropped
 * here, though a move in the gap takes the ticket out of the group the pick was
 * about. `endHold`, which every writer of a ticket's group calls in the move's
 * own transaction, drops it (`movedGroup`): for a rule's move, which never asks
 * this, as for a person's, and on a ticket nobody may work, where this hands
 * nothing over. One mechanism, so that no mover is left out of it: dropped here
 * as well, the console's move and Hand to cleared the pick twice and a rule's
 * move not at all. A re-arm alone drops nothing: a category or an assignee
 * written in the gap leaves the ticket in the group the pick was made for, and
 * an `on_create` rule's pick has no later pass to make it again.
 */
export async function deferToRouter(tx: Tx, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: routingDecisions.id, phaseOneAt: routingDecisions.phaseOneAt })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    )
    .for('update');
  if (!row?.phaseOneAt) return false;

  // The ticket as the write left it. Its lock is the write's, so this takes
  // none and waits on nobody; the status through `statusCategoryOf` all the
  // same, the one way a read of the row asks it.
  const [ticket] = await tx
    .select({
      statusId: conversations.statusId,
      statusCategory: statusCategoryOf(),
      deletedAt: conversations.deletedAt,
      isSpam: conversations.isSpam,
      mergedIntoId: conversations.mergedIntoId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (
    !ticket ||
    !isWorkable({ ...ticket, statusCategory: await lockedStatusCategory(tx, ticket) })
  ) {
    return false;
  }

  await tx
    .update(routingDecisions)
    .set({
      rulesClaimedAt: null,
      // Read off the row as it was, as every expression in a SET is: a claim
      // still running keeps its age; a mark of done goes with its claim; a
      // re-arm already kept keeps the age it kept.
      rulesDoneAt: sql`case
        when ${routingDecisions.rulesDoneAt} is null then ${routingDecisions.rulesClaimedAt}
        when ${routingDecisions.rulesClaimedAt} is null then ${routingDecisions.rulesDoneAt}
      end`,
    })
    .where(eq(routingDecisions.id, row.id));
  return true;
}

/**
 * The policies and the hours a write needs to re-time the clocks inside its
 * own transaction should it hand its pass to the router there
 * (`onPriorityChangedIn`, `onStatusChangedIn`): the console's priority and
 * status, and the priority classifier's applied answer. Loaded before that
 * transaction opens, on the pool, since a pooled read under the write's lock
 * is a second connection wanted by one already held (§6.91).
 *
 * Only when an unlocked read finds a decision in flight — phase one written,
 * the row undecided — the one case `deferToRouter` can answer true; any other
 * write, on nearly every ticket, pays this one indexed read and no more. And
 * best-effort, as every re-time is (`lib/sla`): a read or a load that fails is
 * logged and answers null, and the write goes on — outside any transaction, so
 * nothing is left to roll back. Loaded for every such write, and before
 * its transaction outside any try, a catalog that could not be read failed the
 * edit itself, where it had been written and the re-time's failure logged; and
 * a write that kept its pass read the policies and the catalog twice, once
 * here and once to re-time after its commit.
 *
 * A write that defers with no inputs — the read raced a phase one written
 * after it, or the load failed — re-times after its commit, as a write that
 * keeps its pass does, and still hands the pass over. What that costs is the
 * order the re-time inside the write exists for: the router's pass claims the
 * ticket as soon as the write commits, and may read the clock from before the
 * change, so a rule asking `is_first_response_overdue` can answer from
 * medium's deadline on a ticket just raised to urgent. Only on that race or a
 * failed read, and the clock itself is right once the re-time lands.
 */
export async function clockInputsIfInFlight(conversationId: string): Promise<ClockInputs | null> {
  try {
    const [inFlight] = await db
      .select({ id: routingDecisions.id })
      .from(routingDecisions)
      .where(
        and(
          eq(routingDecisions.conversationId, conversationId),
          ne(routingDecisions.stage, 'decided'),
          isNotNull(routingDecisions.phaseOneAt),
        ),
      );
    return inFlight ? await loadClockInputs() : null;
  } catch (error) {
    log.error(`could not load the clocks' policies and hours for ${conversationId}`, error);
    return null;
  }
}

/**
 * The outcomes that are not the router's: `endHold`'s two, written by a person
 * or a rule deciding without looking at the category at all, and `not_open`,
 * where the router found the ticket in nobody's queue and ran no pass.
 */
const NOT_THE_ROUTERS_PASS: ReadonlySet<RoutingOutcome> = new Set(['manual', 'rule', 'not_open']);

/**
 * Whether the router's pass over the `on_update` rules covers a category
 * written on a held ticket before any phase one had — asked by the category's
 * writer, the console's edit or Jev's answer, once `routeNow` has answered
 * anything but `decided`. A writer that found phase one already written handed
 * its pass to the router there and then (`deferToRouter`) and never asks; so
 * whatever this finds was decided, or is being decided, after the write
 * committed, in the moment before the writer's own call reached the router.
 * True, and the writer runs no pass of its own, which would be a second: every
 * rule keyed on the category fires twice, a canned reply sent twice, a note
 * written twice. False, and the pass is the writer's.
 *
 * - **Undecided** — a phase one written since, which some caller is finishing
 *   (`in_flight`), or none yet, the writer's own `routeNow` having `failed`:
 *   true. Phase one, then or at the window's end, reads the ticket after this
 *   write, and the router's pass after it.
 * - **Decided by the router** — its phase one read the ticket under the lock
 *   after this write committed, and its pass ran on this category or on a
 *   later writer's, whose pass it then is: true either way.
 * - **Not the router's decision** — `manual` or `rule`, or `not_open`: false.
 *   `endHold` decides without reading the category, and `not_open` ran no
 *   pass; a router owing nothing is not the edit's pass having run, and a
 *   person's edit on a ticket resolved in its window meets its rules as an
 *   edit on any resolved ticket does.
 * - **No row** — purged with its ticket in that moment: false, and the
 *   writer's own pass finds no ticket.
 */
export async function routerDecidedOn(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  if (!row) return false;
  if (row.stage !== 'decided') return true;
  return row.outcome !== null && !NOT_THE_ROUTERS_PASS.has(row.outcome);
}
