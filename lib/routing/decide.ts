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
 * Whose words the category a ticket carries stands on, as the router reads it
 * under the ticket's lock (`categorySource`, `lib/routing/category-source.ts`).
 * Null for a ticket with no category.
 */
export type CategorySource = {
  /** The category was last written by Jev answering one of the ticket's messages. */
  readByJev: boolean;
  /**
   * No answer of Jev's about a message the ticket's requester wrote — as the
   * requester is now — chose it: every one that did was about somebody else's
   * words. Only `readByJev` makes this a question at all.
   */
  notTheRequesters: boolean;
  /**
   * A comment thread a reply opened, whose root comment is not on the ticket
   * yet: the customer whose comment the reply answers may still arrive and take
   * the ticket over (`adoptRootAuthor`, `lib/tickets/ingest-meta.ts`).
   */
  awaitingRoot: boolean;
};

/**
 * What a decision that would read the ticket's category does with it: `routes`
 * on it, `waits` — decides nothing yet, and leaves the ticket held for the
 * window's end or a later answer — or sets it `set_aside`, deciding as though
 * no category had settled (`fallback`).
 *
 * Meta delivers a comment thread in no order, so a passer-by's reply under a
 * customer's comment can be stored first and open the ticket under the
 * passer-by; the customer's comment, when it comes, makes its author the
 * requester. Jev answers within seconds, so without this the router decided
 * on the passer-by's words before the customer's could arrive — moved the
 * ticket to the team those words named, ran that category's rules, chose its
 * policy and assigned it — and a decided ticket is never routed again.
 *
 * A category somebody else wrote — a person, a rule, a form — is never held
 * back by this: it routes whenever the router next decides, as it always has,
 * since somebody chose it and nothing about the thread's order changes that
 * choice. Only Jev's reading of somebody's words waits:
 *
 * 1. **Read off somebody who is not the requester now** — the replier, after
 *    the root took the ticket, while the root's own answer has not settled
 *    anything (unknown, below the threshold, a root with no words). Before the
 *    window's end it waits, since the customer's next message may still settle
 *    the ticket; at the window's end it is set aside, and the ticket stays in
 *    the group it arrived in. The category stays on the ticket as a label, for
 *    a person or the customer's own next answer to replace.
 * 2. **Read off the requester, on a thread still waiting for its root** —
 *    waits before the window's end; at the window's end it routes, since
 *    nobody else has arrived to take the ticket, and a reply whose root never
 *    comes — one under the Page's own comment, which ingest never stores, or
 *    under a comment older than the subscription — is the customer's own.
 * 3. **Anything else** routes.
 *
 * Waiting costs a ticket a reply opened the window's length before it is
 * assigned, where a ticket its root opened is routed as soon as Jev answers.
 * A root arriving after the window's end changes nothing the router did: the
 * decision is made once, and the root's answer only relabels the ticket. And
 * while it waits, the ticket carries the replier's category, so another
 * writer's `on_update` pass in that time — the priority classifier's, a
 * customer's message's — meets a rule keyed on that category as it would on
 * any held ticket, and an `assign_group` there ends the hold as `rule`.
 * Accepted: no active rule is keyed on the category (2026-11-06), and a team
 * that adds one decides through it rather than through the router.
 */
export function categoryStanding(
  source: CategorySource | null,
  atWindowEnd: boolean,
): 'routes' | 'waits' | 'set_aside' {
  if (!source?.readByJev) return 'routes';
  if (source.notTheRequesters) return atWindowEnd ? 'set_aside' : 'waits';
  if (source.awaitingRoot && !atWindowEnd) return 'waits';
  return 'routes';
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
