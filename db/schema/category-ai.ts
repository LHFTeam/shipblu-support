import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { channels } from './config';
import { conversations, messages } from './conversations';
import { channelEnum, requesterKindEnum } from './enums';

/**
 * The run label every answer the live classifier gives is filed under.
 *
 * Settling and the ownership test read only these rows: a backfill measuring
 * the archive under a label of its own must never settle a live ticket, so its
 * payload refuses this label. Here rather than in `lib/category-ai/`, for the
 * reason `RERUNNABLE_STEPS` sits in `config.ts`: `lib/queue/payloads.ts` needs
 * it, and importing it from the module the queue's job runs would be a cycle.
 */
export const CATEGORY_AI_LIVE_LABEL = 'live';

/**
 * Every answer Jev gave about which team's work a ticket is, and what was done
 * with it (`plans/ticket-category-routing.md`, decision 4).
 *
 * Not the table `ai_category_runs` was before Stage 2.B: that one was the
 * subcategory shadow table, renamed `ai_subcategory_runs` by migration 0046,
 * and 0047 freed its primary key's name on a fresh database so this table's
 * key is `ai_category_runs_pkey` everywhere.
 *
 * Like `ai_priority_runs`, the evidence for writes the classifier makes, and
 * like `ai_subcategory_runs`, filed under a run label, so the archive can be
 * measured again under a new question without touching what the live
 * classifier answered. Nothing on a ticket says who set its category except the
 * `category_changed` event, and only these rows say what Jev weighed.
 */
export const aiCategoryRuns = pgTable(
  'ai_category_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /**
     * `set null` on delete, as the other two runs tables do: the run is
     * evidence about the classifier, and a deleted message must not take it.
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /**
     * When the message was written, frozen. Settling is decided by the
     * earliest message on the ticket, and jobs run in no order, so the order
     * has to survive the message itself being deleted — a join to `messages`
     * would lose it the moment `message_id` goes null.
     */
    messageCreatedAt: timestamp('message_created_at', { withTimezone: true }).notNull(),

    /** `live` (`CATEGORY_AI_LIVE_LABEL`) or a backfill's own label. */
    runLabel: text('run_label').notNull(),

    /** `shadow` or `apply` for a live answer, `record` for a backfill's. */
    mode: text('mode').notNull(),

    /**
     * A hash of the question exactly as sent, and of the shape of its state.
     * An admin editing a category's label or description changes the question,
     * and a report must not average two questions.
     */
    requestFingerprint: text('request_fingerprint').notNull(),

    /** The model as the response named it — `jev-1.13.0`. Null when nothing was asked. */
    model: text('model'),

    /** Whether earlier messages on the ticket were in `state`. */
    withContext: boolean('with_context').notNull().default(false),

    /**
     * A category key, or `unknown`. Frozen text rather than a foreign key, the
     * subcategory runs' convention: `unknown` has no row, and a key outlives a
     * label an admin edits.
     */
    predictedKey: text('predicted_key'),

    /** The winner's own share of the distribution — what the threshold is compared with. */
    probability: doublePrecision('probability'),

    /** TypeSafe's statistic over the whole distribution, a different question. */
    confidence: doublePrecision('confidence'),

    /** Every option's share, so a threshold sweep never needs the corpus again. */
    probabilities: jsonb('probabilities').notNull().default({}),

    /**
     * The threshold in force when the outcome was decided. `below_threshold`
     * and `would_apply` mean nothing once an admin moves it, unless the row
     * says which line it was measured against.
     */
    minProbability: doublePrecision('min_probability'),

    /** The key of the category the ticket carried when the answer was weighed. */
    categoryKeyBefore: text('category_key_before'),

    /** What was done with it: `CategoryOutcome` in `lib/category-ai/decide.ts`. */
    outcome: text('outcome').notNull(),

    /**
     * The free baseline, computed beside the answer and never sent to Jev:
     * what the rules detector found in the same text, through the reviewed
     * area-to-category map in `lib/category-ai/baseline.ts`. Null where the map
     * gives no category.
     */
    baselineCategoryKey: text('baseline_category_key'),

    /** The detector's own subcategory keys, so the map can be reviewed again without recomputing. */
    baselineSubcategoryKeys: text('baseline_subcategory_keys').array().notNull().default([]),

    /** The ticket's channel and channel row, frozen: the report breaks every figure down by them. */
    channel: channelEnum('channel').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),

    /** Whether a shipment was linked to the ticket by the time of the message. */
    hasShipment: boolean('has_shipment').notNull().default(false),

    /**
     * The ticket's `requester_kind` when the row was written — read off the
     * contact's records by ingest (`requesterKindFrom`), never by Jev, so a
     * slice by it says who the records said was writing. A backfill writes it
     * as it is now: the column keeps no history.
     */
    requesterKind: requesterKindEnum('requester_kind'),

    inputTokens: integer('input_tokens'),
    latencyMs: integer('latency_ms'),

    /** Why there is no prediction on a `failed` row. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One answer per message per label. Led by the message rather than the
    // label, so the one index also serves the `set null` foreign key, which
    // otherwise scans the whole table for every deleted message — a table that
    // grows with every inbound message and every backfill label.
    uniqueIndex('ai_category_runs_message_label_idx').on(t.messageId, t.runLabel),
    // Settling, the cap and the cascade, all per ticket in message order.
    index('ai_category_runs_conversation_idx').on(t.conversationId, t.messageCreatedAt),
    // The report, one label at a time.
    index('ai_category_runs_label_idx').on(t.runLabel, t.createdAt),
  ],
);

/**
 * The category classifier's switch, its threshold and the routing window, set
 * on `/admin/categories`.
 *
 * A table rather than environment variables, the canned suggestions' reason:
 * production already holds `TYPESAFE_API_KEY`, so key-as-flag would switch the
 * classifier on in every environment holding the key. One row, pinned to
 * `id = 1` by `db/sql/003_constraints.sql`; no row is a fresh install and reads
 * as off, so staging stays off because its database says so.
 *
 * The routing window is Stage 5's — how long a fresh ticket is held for a
 * category before it routes without one — and is stored here from 4.1 so the
 * one page sets everything the classifier and the router read.
 */
export const categoryAiSettings = pgTable('category_ai_settings', {
  id: integer('id').primaryKey().default(1),
  mode: text('mode').notNull().default('off'),
  minProbability: doublePrecision('min_probability').notNull().default(0.6),
  routingWindowMinutes: integer('routing_window_minutes').notNull().default(5),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAgentId: uuid('updated_by_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
});
