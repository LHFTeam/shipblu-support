import { eq } from 'drizzle-orm';
import type { db } from '@/db/client';
import { conversations, routingDecisions } from '@/db/schema';
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
 * transaction; `startRouting` writes inside it with nothing to read.
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
 * that decides whether this message is classified at all, so a ticket is held
 * only when its message will be asked about. A failed read is off, and starts
 * nothing.
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

/**
 * Open the window for a ticket the caller has just inserted, with the message
 * that opened it. Call it in the insert branch only — a continuation, a reopen,
 * an imported thread or one the business wrote first never routes.
 *
 * Starts nothing for a ticket somebody already holds — a WhatsApp number's
 * owner is stamped in the insert, and the owner is outside the rota — nor for
 * one filed as spam (an email bounce or out-of-office), which nobody routes.
 * Either would only be recorded as `taken` or `not_open` at the window's end.
 *
 * The window counts from `now`, when ingest processed the message, and never
 * from the message's own instant: email's `created_at` is our receipt, and a
 * message processed late after a worker pause still gets its whole window. One
 * instant for the column and the job, so the job is due exactly when the
 * window closes.
 *
 * A shadow row gets the same row and job and no window on the ticket: nothing
 * is held, and the job records the would-be decision if nothing did before it.
 */
export async function startRouting(
  tx: Tx,
  plan: RoutingPlan | null,
  ticket: {
    conversationId: string;
    messageId: string;
    groupId: string | null;
    isSpam?: boolean;
    assigneeAgentId?: string | null;
  },
  now: Date = new Date(),
): Promise<void> {
  if (!plan || ticket.isSpam || ticket.assigneeAgentId) return;

  const endsAt = windowEndsAt(now, plan.windowMinutes);
  const shadow = plan.start === 'shadow';

  if (!shadow) {
    await tx
      .update(conversations)
      .set({ routingWindowEndsAt: endsAt })
      .where(eq(conversations.id, ticket.conversationId));
  }

  await tx.insert(routingDecisions).values({
    conversationId: ticket.conversationId,
    channelId: plan.channelId,
    shadow,
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
 * Behind `classify_category`'s 30, so an answer already queued at the window's
 * end is applied before the window is settled without one; ahead of the
 * default 100.
 */
export const SETTLE_ROUTING_PRIORITY = 40;
