import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { ticketCategories } from './config';
import { conversations, messages } from './conversations';
import { categoryReviewStateEnum, linkSourceEnum } from './enums';

/**
 * Which categories a conversation carries.
 *
 * The two registries this points at live in `db/schema/config.ts`, beside
 * `ticket_statuses`, because `conversations` references them and everything else
 * references `conversations` — putting a registry in a leaf module is what would
 * make the schema's import graph circular.
 *
 * Many-to-many, because a ticket is routinely about more than one thing. "The
 * courier never called and now I want to cancel" is two categories, and filing it
 * as one throws away the half somebody would have acted on.
 */
export const conversationCategories = pgTable(
  'conversation_categories',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => ticketCategories.id, { onDelete: 'restrict' }),

    /**
     * The key as it was at assignment time, frozen.
     *
     * Denormalised on purpose, the way `csat_surveys` snapshots the agent it was
     * sent about: a report run next year must read what was actually assigned,
     * not what the registry has since been edited to say. The label an agent sees
     * always comes from the join; this column is provenance.
     */
    categoryKey: text('category_key').notNull(),

    /**
     * Who asserted it.
     *
     * `link_source` rather than a new enum carrying the same three values —
     * `detected` is a rule's opinion, `manual` is an agent taking responsibility,
     * and only the first is ever removed in bulk when a pattern turns out to have
     * been wrong, which is exactly what that enum was written for.
     */
    source: linkSourceEnum('source').notNull().default('detected'),
    reviewState: categoryReviewStateEnum('review_state').notNull().default('auto'),

    /**
     * The evidence grade, 0..1 — **not a probability**.
     *
     * A rules engine has no posterior. This says how directly the thing we
     * matched names the category: 1 for a structured field, 0.9 for the whole
     * message being a known phrase, 0.7 for several words in order, 0.55 for a
     * single keyword. It is declared by the rule author and constant for that
     * rule; it exists to be thresholded on, not read as a chance of being right.
     *
     * Always 1 for a human's own choice, held there by a CHECK — an agent's
     * judgement is not a guess, and storing 0.7 on one would let a threshold
     * sweep reopen a question a person has already answered.
     */
    confidence: doublePrecision('confidence').notNull().default(1),

    isPrimary: boolean('is_primary').notNull().default(false),

    /** Which message earned it — the provenance the sidebar shows. */
    detectedInMessageId: uuid('detected_in_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),

    /**
     * Which rule fired.
     *
     * The tuning surface: grouping rejected rows by this is how you find the rule
     * that over-fires, and it is why a rejected row is kept rather than deleted.
     * Null on a human's own choice, which is itself the signal that the rules
     * missed something.
     */
    ruleKey: text('rule_key'),

    /** What the matcher actually saw — the matched span, the field, the term. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * The build of `lib/categorise` that wrote it.
     *
     * What makes a re-run safe and a rule fix retroactive: the backfill deletes
     * `detected` rows below the current version and rewrites them, so correcting
     * a pattern corrects the archive rather than only the tickets that arrive
     * next. `lib/assignment/skills.ts` gets that property for free by deriving
     * everything; a stored category has to earn it, and this column is the price.
     * It never touches a `manual` row and never touches a `rejected` one.
     */
    detectorVersion: integer('detector_version').notNull().default(0),

    assignedByAgentId: uuid('assigned_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    reviewedByAgentId: uuid('reviewed_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    /**
     * When this category was first earned, and when it was last re-earned.
     *
     * Two timestamps because a ticket is a running thread: "they have been asking
     * about this since Tuesday" and "they mentioned it again an hour ago" are
     * different facts, and the primary tie-break reads the second — so a thread
     * that began as a delay question and became a cancellation reports as the
     * cancellation it now is.
     */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.categoryId] }),

    // At most one primary per conversation, as a database guarantee rather than
    // application discipline: ingest jobs for the same conversation run in
    // parallel on the worker, and "whichever committed last wins" is how a ticket
    // ends up with two primaries and a report that counts it twice.
    uniqueIndex('conversation_categories_primary_idx')
      .on(t.conversationId)
      .where(sql`${t.isPrimary}`),

    // The driver report: every conversation in a category, by date.
    index('conversation_categories_key_idx').on(t.categoryKey, t.firstSeenAt),
    index('conversation_categories_category_idx').on(t.categoryId),

    // The review queue: everything waiting on a click, best evidence first.
    index('conversation_categories_review_idx')
      .on(t.confidence, t.firstSeenAt)
      .where(sql`${t.reviewState} = 'suggested'`),
  ],
);

export const conversationCategoriesRelations = relations(conversationCategories, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationCategories.conversationId],
    references: [conversations.id],
  }),
  category: one(ticketCategories, {
    fields: [conversationCategories.categoryId],
    references: [ticketCategories.id],
  }),
  detectedInMessage: one(messages, {
    fields: [conversationCategories.detectedInMessageId],
    references: [messages.id],
  }),
  reviewedByAgent: one(agents, {
    fields: [conversationCategories.reviewedByAgentId],
    references: [agents.id],
  }),
}));
