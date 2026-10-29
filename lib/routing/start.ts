import type { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';
import { loadCategoryAiSettings } from '@/lib/category-ai/settings';
import { enqueue } from '@/lib/queue';
import { windowEndsAt } from './hold';
import { routingModeOf, routingStartFor, type RoutingStart } from './mode';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where routing starts: the transaction that inserts a ticket on an inbound
 * ingest path — email, WhatsApp, a Meta direct message or comment, and the
 * widget (`plans/ticket-category-routing.md`, decision 5).
 *
 * In that transaction rather than after the creation pass, because the things
 * that can assign a ticket in its first second — the priority classifier's
 * `on_update` pass, an `on_create` rule's group-less `auto_assign`, a sweep, a
 * second message — would otherwise assign it in its default group before the
 * router had its say. The window, the `pending` row and the `settle_routing`
 * job commit with the ticket or not at all.
 *
 * Two halves, because the insert transaction must not read on the pool: a
 * second pooled connection taken while one is held is the self-deadlock the
 * admission gate exists for (§6.91), and on WhatsApp a throw inside the
 * transaction loses the customer's message rather than retrying it.
 * `planRouting` reads the channel's mode and the classifier's switch before the
 * transaction; inside it, with nothing to read, `routingWindowValues` puts the
 * window on the ticket's insert and `startRouting` writes the row and the job
 * once the opening message is stored.
 */

/** What `planRouting` decided before the transaction, for `startRouting` inside it. */
export type RoutingPlan = {
  start: RoutingStart;
  channelId: string;
  windowMinutes: number;
};

/** The channel row a path files its new ticket under, as far as routing reads it. */
export type RoutingChannel = {
  id: string | null;
  type: string;
  config: unknown;
  routingMode: string | null;
};

/**
 * Whether a new ticket on `channel` will enter routing. Null for a ticket filed
 * under no row — a WhatsApp number no row names borrows a group but has no mode
 * to re-read when the router decides — and for every channel `routingModeOf`
 * keeps on its default group.
 *
 * The classifier's switch comes through its thirty-second memo, the same read
 * that decides whether this message is classified at all, so a ticket enters
 * routing — held, or watched in shadow — only while the classifier is in
 * `apply`. Not only when its message will be asked about: the switch is all
 * this reads, and a message carrying no words of the customer's — a photo sent
 * without a caption, stored as `[image]` — is never queued for the
 * classifier, and its ticket is held for the whole window and settles as
 * `fallback` unless words follow. A failed read is off, and starts nothing.
 */
export async function planRouting(channel: RoutingChannel | null): Promise<RoutingPlan | null> {
  if (!channel?.id) return null;
  const mode = routingModeOf(channel);
  if (mode === 'default_group') return null;
  const settings = await loadCategoryAiSettings();
  const start = routingStartFor(mode, settings.mode);
  if (!start) return null;
  return { start, channelId: channel.id, windowMinutes: settings.routingWindowMinutes };
}

/** What the insert knows about its new ticket, as far as starting routing reads it. */
export type RoutingTicket = {
  isSpam?: boolean;
  assigneeAgentId?: string | null;
};

/**
 * Whether `plan` starts anything for this ticket: the one predicate the
 * insert's window and `startRouting`'s row and job both ask, so a ticket the
 * insert holds always has the row and the job that end its hold, and a live
 * row never describes a ticket nothing holds.
 *
 * Nothing for a ticket somebody already holds — a WhatsApp number's owner is
 * stamped in the insert, and the owner is outside the rota — nor for one filed
 * as spam (an email bounce or out-of-office), which nobody routes. Either would
 * only be recorded as `taken` or `not_open` at the window's end.
 */
function starts(plan: RoutingPlan | null, ticket: RoutingTicket): plan is RoutingPlan {
  return plan !== null && !ticket.isSpam && !ticket.assigneeAgentId;
}

/**
 * The window, as a value on the insert that creates the ticket: spread into
 * its `values`, beside the columns the path already writes. Empty unless the
 * plan starts a live hold — a shadow row holds nothing, so its ticket carries
 * no window.
 *
 * On the insert rather than in an UPDATE after it. The hold is read off the
 * ticket's own columns (`isHeld`), and stamping the window a statement later
 * wrote a second version of a row the transaction had only just created, and
 * left the hold to a statement apart from the insert, which a path could lose
 * while still writing the row and the job that say the ticket is held.
 *
 * The window counts from `now`, when ingest processed the message, and never
 * from the message's own instant: email's `created_at` is our receipt, and a
 * message processed late after a worker pause still gets its whole window.
 * The caller takes one `now` and passes it here and to `startRouting`, so the
 * ticket's window, the row's and the job's `run_at` are one instant.
 */
export function routingWindowValues(
  plan: RoutingPlan | null,
  ticket: RoutingTicket,
  now: Date,
): { routingWindowEndsAt?: Date } {
  if (!starts(plan, ticket) || plan.start !== 'live') return {};
  return { routingWindowEndsAt: windowEndsAt(now, plan.windowMinutes) };
}

/**
 * Record the start of routing for a ticket the caller has just inserted, with
 * the message that opened it: the `pending` row and the `settle_routing` job
 * at the window's end. Call it in the insert branch only — a continuation, a
 * reopen, an imported thread or one the business wrote first never routes —
 * with the ticket the insert was given `routingWindowValues` for, and the same
 * `now`: the window itself is already on the ticket, and this writes nothing
 * to it.
 *
 * A shadow row gets the same row and job and no window on the ticket: nothing
 * is held, and the job records the would-be decision if nothing did before it.
 */
export async function startRouting(
  tx: Tx,
  plan: RoutingPlan | null,
  ticket: RoutingTicket & {
    conversationId: string;
    messageId: string;
    groupId: string | null;
  },
  now: Date,
): Promise<void> {
  if (!starts(plan, ticket)) return;

  const endsAt = windowEndsAt(now, plan.windowMinutes);

  await tx.insert(routingDecisions).values({
    conversationId: ticket.conversationId,
    channelId: plan.channelId,
    shadow: plan.start === 'shadow',
    fromGroupId: ticket.groupId,
    messageId: ticket.messageId,
    windowEndsAt: endsAt,
    startedAt: now,
  });

  // Keyed on the ticket, and spent for good, which is right only because a
  // ticket routes once. On the insert transaction, so a ticket rolled back by
  // a duplicate delivery's unique index does not spend the key either.
  await enqueue(
    'settle_routing',
    { conversationId: ticket.conversationId },
    {
      on: tx,
      runAt: endsAt,
      priority: SETTLE_ROUTING_PRIORITY,
      dedupeKey: `settle_routing:${ticket.conversationId}`,
    },
  );
}

/**
 * Behind `classify_category`'s 30 and ahead of the default 100. The priority
 * orders only the claim: a classifier job due beside this one is claimed
 * first, but the worker runs what it claims at once, so this sees an answer
 * that has already landed and nothing still in flight. An answer that lands
 * after the window is settled is a late one, and relabels the ticket where
 * the window left it.
 */
export const SETTLE_ROUTING_PRIORITY = 40;
