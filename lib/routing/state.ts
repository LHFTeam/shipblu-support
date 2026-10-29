import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';
import type { RoutingOutcome } from './decide';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where an undecided ticket's routing stands, as `undecidedRouting` answers it. */
export type UndecidedRouting = {
  shadow: boolean;
  stage: 'pending' | 'holding';
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
    .select({ shadow: routingDecisions.shadow, stage: routingDecisions.stage })
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
  return { shadow: row.shadow, stage: row.stage === 'pending' ? 'pending' : 'holding' };
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
 * console's category, group and assignee cases, Hand to, and Jev's answer —
 * in its write's own transaction, once the write holds the ticket's lock. Not
 * by an agent's reply, which runs no pass; nor by a rule, whose pass is either
 * the router's own or one that read the ticket before this decision existed.
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
 * So the write re-arms the router's pass instead: its claim cleared, and its
 * mark of done with it. Under the ticket's lock, which the write took first,
 * and then the routing row's, the order every routing writer takes them in,
 * this write is ordered against each of the router's steps that read the
 * ticket or end the hold, both of which take the ticket's lock too:
 *
 * - **before the router's claim**, the pass the claim begins reads this write;
 * - **after it**, the pass read the ticket before this write, and phase three,
 *   finding the claim cleared, runs it again instead of ending the hold;
 * - **after phase three**, the row is decided, this answers false, and the
 *   writer's pass is a relabel's, like any write after the hold.
 *
 * A router that died meanwhile leaves the row undecided and the pass unclaimed,
 * which `settle_routing` claims and runs when it completes the decision — never
 * read as a claimant that died part-way, since a cleared claim is no claim.
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
  await tx
    .update(routingDecisions)
    .set({ rulesClaimedAt: null, rulesDoneAt: null })
    .where(eq(routingDecisions.id, row.id));
  return true;
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
