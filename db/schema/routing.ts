import {
  boolean,
  doublePrecision,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents, groups } from './agents';
import { channels, ticketCategories } from './config';
import { conversations, messages } from './conversations';
import { assignmentStrategyEnum, routingOutcomeEnum, routingStageEnum } from './enums';

/**
 * One row per ticket that entered routing by category, live or shadow
 * (`plans/ticket-category-routing.md`, decision 5). Written in the insert
 * transaction of the ticket it describes (`startRouting`) and then only by
 * `lib/routing/`, always under the ticket's row lock.
 *
 * The ticket's own two columns (`routing_window_ends_at`, `routing_decided_at`)
 * are what the hold is computed from; this is the record of how it ended —
 * which the timeline's `routed` event summarises and the routing report reads.
 * A shadow row holds nothing: its outcome, `to_group_id` and `decided_at` are
 * where the ticket would have gone, and when.
 */
export const routingDecisions = pgTable(
  'routing_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** The channel whose mode started it. A deleted channel leaves the record. */
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),

    /** Recorded only: nothing was held, and nothing moves. */
    shadow: boolean('shadow').notNull(),

    stage: routingStageEnum('stage').notNull().default('pending'),

    /** Null until decided. Never overwritten once set. */
    outcome: routingOutcomeEnum('outcome'),

    /** The group the ticket started in — its channel's default group. */
    fromGroupId: uuid('from_group_id').references(() => groups.id, { onDelete: 'set null' }),

    /** Where the decision put the ticket, or would have on a shadow row. */
    toGroupId: uuid('to_group_id').references(() => groups.id, { onDelete: 'set null' }),

    /**
     * The settled category the decision was made on, and, when Jev filed it,
     * Jev's probability. `restrict`, as every reference to a category is: a
     * category is retired, never deleted.
     */
    categoryId: uuid('category_id').references(() => ticketCategories.id, {
      onDelete: 'restrict',
    }),
    probability: doublePrecision('probability'),

    /**
     * Who decided: the person, or the label of whatever did — the rule, Jev
     * (`jev:category`), or `settle_routing` at the end of the window.
     */
    decidedByAgentId: uuid('decided_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    decidedByLabel: text('decided_by_label'),

    /**
     * The message that opened the ticket, which the held out-of-hours reply
     * answers once the hold ends — the message the creation pass would have
     * answered had nothing been held. `set null`: the record outlives it.
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /** The end of the window — the would-be one on a shadow row. */
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * When phase one wrote the decision, which the hold outlasts until the
     * rules have run (`lib/routing/apply.ts`). `settle_routing` completes a
     * decision whose phase one is more than a minute old and leaves a younger
     * one to the caller still running it.
     */
    phaseOneAt: timestamp('phase_one_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    /**
     * An `auto_assign` rule's strategy, and the rule's label, met on a held
     * ticket: the pick it asked for waits for the hold, and whatever ends the
     * hold makes it with these (`afterHoldEnded`). Without them a round-robin
     * rule over a group set to `manual` — the way a rule turns assignment on
     * for a ticket without moving it — leaves every held ticket unassigned.
     * Written by `assignConversation` when it answers `awaiting_route`;
     * cleared by the router's phase one when its own rules follow, so only a
     * rule matching the ticket as the decision left it is replayed, and by
     * `endHold`, whose person or rule has decided instead. Both null, or both
     * set.
     */
    heldStrategy: assignmentStrategyEnum('held_strategy'),
    heldActorLabel: text('held_actor_label'),
  },
  (t) => [
    // Routing happens once per ticket, and every reader finds the row by it.
    uniqueIndex('routing_decisions_conversation_idx').on(t.conversationId),
    // The routing report, a channel at a time over a range.
    index('routing_decisions_channel_idx').on(t.channelId, t.startedAt),
    // The `set null` foreign key: a purge deleting a ticket's messages would
    // otherwise scan the whole table once for every message it deletes.
    index('routing_decisions_message_idx').on(t.messageId),
  ],
);
