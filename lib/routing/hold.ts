/**
 * The hold: while it lasts, nothing assigns the ticket and the out-of-hours
 * reply waits, so the router decides where the ticket belongs before anybody in
 * its default group is handed it (`plans/ticket-category-routing.md`,
 * decision 5).
 *
 * Pure, over the ticket's own columns, because every reader already has the
 * row: `assignConversation` reads it whole, the out-of-hours reply reads it,
 * and the inbox draws "Routing…" from it.
 */

/**
 * How long past the window a hold survives a `settle_routing` that never
 * came. A safety valve for a stuck job, not a second window: in normal running
 * the job or a stamp ends the hold, and it never lapses at the instant the job
 * becomes due — which would let a sweep assign the ticket in its default group
 * just as the router moves it.
 */
export const ROUTING_GRACE_MS = 10 * 60_000;

export type HoldColumns = {
  routingWindowEndsAt: Date | null;
  routingDecidedAt: Date | null;
  assigneeAgentId: string | null;
};

/**
 * Held exactly while the window was opened, nothing has decided, nobody holds
 * the ticket, and the grace has not run out.
 *
 * An assignee ends it whoever gave it, because the hold exists to keep the
 * ticket out of a default-group agent's queue, and once somebody holds it the
 * router records `taken` and never moves it: a ticket that appeared in one
 * agent's queue and then vanished is what the design rejected.
 */
export function isHeld(ticket: HoldColumns, now: Date): boolean {
  if (!ticket.routingWindowEndsAt || ticket.routingDecidedAt || ticket.assigneeAgentId) {
    return false;
  }
  return now.getTime() < ticket.routingWindowEndsAt.getTime() + ROUTING_GRACE_MS;
}

/** The end of a window of `minutes` opened at `now`. */
export function windowEndsAt(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}
