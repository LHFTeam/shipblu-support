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
import { priorityEnum } from './enums';

/**
 * Every answer Jev gave about a message's priority, and what was done with it.
 *
 * Unlike `ai_category_runs` this is not a shadow table that nothing acts on —
 * the classifier writes `conversations.priority` — but it is the only place the
 * evidence for those writes lives. No ticket in the archive carried a priority
 * anybody chose when this shipped, so these rows are the first labels there
 * are: an `applied` row followed by an agent's `priority_changed` is the
 * disagreement the threshold is tuned from, and a `would_apply` row is the same
 * measurement taken before anything was allowed to move.
 *
 * `conversations.priority` itself says nothing about who set it, and the
 * timeline event says only that something did. Without the full distribution
 * kept here, deciding where `PRIORITY_AI_MIN_PROBABILITY` should sit would mean
 * paying for the corpus again.
 */
export const aiPriorityRuns = pgTable(
  'ai_priority_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /**
     * One answer per message, ever — the unique index below is what makes a
     * re-delivered job a no-op rather than a second opinion. `set null` on
     * delete, as `ai_category_runs` does: the run is evidence about the
     * classifier, and a deleted message must not take it along.
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /** `shadow` or `apply`: whether this answer was allowed to write. */
    mode: text('mode').notNull(),

    /** The model as the response named it — `jev-1.13.0`, never the alias asked for. */
    model: text('model'),

    /** Whether earlier messages on the ticket were in `state`. */
    withContext: boolean('with_context').notNull().default(false),

    /**
     * The level Jev chose. An enum rather than free text because
     * `lib/categorise-ai/map.ts` refuses an answer outside the levels offered,
     * and the levels offered are exactly `PRIORITIES`.
     */
    predicted: priorityEnum('predicted'),

    /** The winner's own share of the distribution — what the threshold is compared with. */
    probability: doublePrecision('probability'),

    /** TypeSafe's statistic over the whole distribution, a different question. */
    confidence: doublePrecision('confidence'),

    /** Every level's share, so a threshold sweep never needs the corpus again. */
    probabilities: jsonb('probabilities').notNull().default({}),

    /** The ticket's priority when the answer was weighed. */
    priorityBefore: priorityEnum('priority_before').notNull(),

    /**
     * What was done with it: `PriorityOutcome` in `lib/priority-ai/decide.ts`.
     *
     * Recorded for every answer rather than only the applied ones, because a
     * classifier that was overruled by its own rules looks, from the ticket,
     * exactly like one that agreed.
     */
    outcome: text('outcome').notNull(),

    inputTokens: integer('input_tokens'),
    latencyMs: integer('latency_ms'),

    /** Why there is no prediction on this row: a permanent refusal from the provider. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_priority_runs_message_idx').on(t.messageId),
    index('ai_priority_runs_conversation_idx').on(t.conversationId, t.createdAt),
    index('ai_priority_runs_created_idx').on(t.createdAt),
  ],
);
