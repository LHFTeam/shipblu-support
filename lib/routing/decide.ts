import type { StatusCategory } from '@/lib/tickets/vocabulary';
import type { RoutingMode } from './mode';

/**
 * What the router decides about one ticket, given the ticket as it is under
 * its row lock (`plans/ticket-category-routing.md`, decision 5). Pure, so the
 * precedence is a test rather than a reading of `apply.ts`.
 */

/** `decide`'s six, and `endHold`'s two. The values of `routingOutcomeEnum`. */
export const ROUTING_OUTCOMES = [
  'taken',
  'not_open',
  'released',
  'category',
  'no_route_for_category',
  'fallback',
  'manual',
  'rule',
] as const;
export type RoutingOutcome = (typeof ROUTING_OUTCOMES)[number];

/** The outcomes `decide` answers; `endHold` writes the other two. */
export type DecidedOutcome = Exclude<RoutingOutcome, 'manual' | 'rule'>;

export type DecideInput = {
  /** A shadow row records where the ticket would have gone; nothing was held. */
  shadow: boolean;
  assigneeAgentId: string | null;
  statusCategory: StatusCategory;
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  /** The channel's mode now, through `routingModeOf` — not as it was at the insert. */
  mode: RoutingMode;
  /** The ticket's group now. */
  groupId: string | null;
  /** The settled category, and the group it routes to; both null when none is settled. */
  categoryId: string | null;
  routeGroupId: string | null;
};

export type Decision = {
  outcome: DecidedOutcome;
  /** Where the ticket ends up — the route group on `category`, else where it is. */
  toGroupId: string | null;
};

/**
 * Tested in this order, each step only reached when every one before it did
 * not answer:
 *
 * 1. **`taken`** — somebody already holds the ticket, from something that
 *    assigns without stamping: the sweep after the grace, or a stuck worker.
 *    Never moved; recorded so the report shows it. Not on a shadow row, where
 *    nothing was held and the default group's rota assigning on arrival is
 *    expected: counting that would report every ticket on a staffed group as
 *    kept, a routing rate the live mode would never have.
 * 2. **`not_open`** — resolved, closed, spam, deleted or merged. Nothing moves.
 * 3. **`released`** — the channel no longer routes by category. Nothing moves,
 *    and what was held goes ahead in the current group. A shadow row is
 *    released only by `default_group`: a channel moved on to `category` still
 *    wants the shadow ticket's would-be answer.
 * 4. **`category`** — a settled category whose route group is elsewhere.
 * 5. **`no_route_for_category`** — a settled category with no route group, or
 *    whose route group is where the ticket already is.
 * 6. **`fallback`** — no category settled. It stays.
 */
export function decide(input: DecideInput): Decision {
  const stay = (outcome: DecidedOutcome): Decision => ({ outcome, toGroupId: input.groupId });

  if (!input.shadow && input.assigneeAgentId) return stay('taken');

  if (!isWorkable(input)) return stay('not_open');

  if (input.shadow ? input.mode === 'default_group' : input.mode !== 'category') {
    return stay('released');
  }

  if (input.categoryId) {
    if (input.routeGroupId && input.routeGroupId !== input.groupId) {
      return { outcome: 'category', toGroupId: input.routeGroupId };
    }
    return stay('no_route_for_category');
  }

  return stay('fallback');
}

/**
 * Whether anybody may still work the ticket: open or pending, and not spam,
 * deleted or merged — what `not_open` answers the absence of. The one copy of
 * that rule, asked in five places so that none of them can come to read it
 * differently:
 *
 * - the router, twice: here, and again in `phaseOne` (`lib/routing/apply.ts`)
 *   when it completes a decision whose caller died between its phases, where
 *   the ticket may have been resolved or deleted since the decision was
 *   written, and is then owed nothing;
 * - the inbox's "Routing…" (`routingHold`, `lib/tickets/inbox-badges.ts`), so
 *   the badge is drawn on exactly the tickets the router would still move;
 * - assignment (`isWorkToHandOut`, `lib/assignment/index.ts`), of the snapshot
 *   and again under the pick's lock, and Hand to (`handToTarget`,
 *   `lib/routing/hand-to.ts`), offered only on a ticket assignment counts as
 *   work to hand out. Both add that the ticket is not on a read-only channel,
 *   which is assignment's question rather than the router's: no bot ticket
 *   ever routes (`routingModeOf`).
 *
 * Pure, and client-safe for the badge.
 */
export function isWorkable(
  ticket: Pick<DecideInput, 'statusCategory' | 'deletedAt' | 'isSpam' | 'mergedIntoId'>,
): boolean {
  return (
    !ticket.deletedAt &&
    !ticket.isSpam &&
    !ticket.mergedIntoId &&
    (ticket.statusCategory === 'open' || ticket.statusCategory === 'pending')
  );
}
