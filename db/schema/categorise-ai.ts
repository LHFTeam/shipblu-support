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
import { conversations, messages } from './conversations';

/**
 * What TypeSafe's model said about a message, beside what the rules said.
 *
 * A shadow table, and the shadow is the design rather than a first step that was
 * not finished. `conversation_categories` is read by the review queue, the
 * primary ladder and both nightly rollups, and its `confidence` column is
 * documented and rendered as an *evidence grade* — a hand-assigned 0.9 / 0.7 /
 * 0.55 combined by noisy-OR, deliberately not a probability. TypeSafe returns an
 * actual probability. Writing one into the other would put two different
 * quantities in one column that three screens explain as a third thing, and the
 * conflation would be invisible the moment it happened.
 *
 * So nothing here is joined to anything that reports. This table exists to answer
 * one question — would a model classify this archive better than the rules do —
 * with enough of each run recorded that the answer can be re-derived later
 * without paying for the corpus again. Promoting a result is a separate,
 * deliberate change; it is not something a threshold in here can drift into.
 *
 * No foreign key on `predicted_key`. `lib/categorise-ai/map.ts` checks the answer
 * against the options the request offered, which is the real invariant; a foreign
 * key would additionally forbid recording a wrong prediction, and recording wrong
 * predictions is the point.
 */
export const aiCategoryRuns = pgTable(
  'ai_category_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /**
     * Nullable and `set null`, the way `conversation_categories.detected_in_message_id`
     * is: a deleted message must not take the measurement with it, because the
     * run is evidence about the detector rather than about the ticket.
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /**
     * Which experiment this row belongs to.
     *
     * The unique index below is `(run_label, message_id)`, which is what makes the
     * backfill idempotent — a re-run after a transient failure fills the gaps and
     * touches nothing else — while still allowing the same message to be measured
     * again under a new label when the question, the model or the option list
     * changes. Overwriting instead would destroy the earlier answer, and the whole
     * value of a shadow run is being able to compare two of them.
     */
    runLabel: text('run_label').notNull(),

    /**
     * The model that answered, as the response named it — `jev-1.13.0`.
     *
     * Not the string the request asked for. `jev-latest` is an alias and moves; a
     * row recording the alias could not say which model produced it a month later.
     */
    model: text('model'),

    /** Whether earlier messages on the ticket were in `state`. Never inferred at read time. */
    withContext: boolean('with_context').notNull().default(false),

    /** Frozen as text, the `conversation_categories.category_key` convention. */
    predictedKey: text('predicted_key'),

    /** The winner's own share of the distribution. */
    probability: doublePrecision('probability'),

    /** TypeSafe's statistic over the whole distribution — a different question. */
    confidence: doublePrecision('confidence'),

    /**
     * Every option's share.
     *
     * The column that makes this table worth keeping: a threshold sweep after the
     * fact reads it, and without it deciding where an auto-apply line should sit
     * would mean running the corpus again.
     */
    probabilities: jsonb('probabilities').notNull().default({}),

    /**
     * What the rules detector returned for the same text, at the same moment.
     *
     * Computed by calling the pure detector rather than read back from
     * `conversation_categories`, and that is the difference between measuring the
     * detector and measuring the agents: those rows may since have been confirmed,
     * rejected or added by hand.
     */
    rulesKeys: text('rules_keys').array().notNull().default([]),
    rulesTopConfidence: doublePrecision('rules_top_confidence'),

    /** Measured, not estimated — the two figures any decision about cost will want. */
    inputTokens: integer('input_tokens'),
    latencyMs: integer('latency_ms'),

    /**
     * Why there is no prediction on this row.
     *
     * A failed call is recorded rather than skipped: a run that quietly covered
     * 600 of 640 messages and a run that covered all of them look identical from
     * the outside, and the difference is exactly the systematic gap that a
     * per-channel breakdown is supposed to expose.
     */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_category_runs_label_message_idx').on(t.runLabel, t.messageId),
    index('ai_category_runs_label_idx').on(t.runLabel, t.createdAt),
    index('ai_category_runs_conversation_idx').on(t.conversationId),
  ],
);
