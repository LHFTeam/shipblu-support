import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { cannedResponses } from './config';
import { conversations, messages } from './conversations';
import { channelEnum, suggestionEditEnum } from './enums';

/**
 * Every canned response TypeSafe's Jev suggested in the reply composer, and what
 * the agent did with it.
 *
 * Not a shadow, unlike `ai_category_runs`: the answer here is shown to an agent
 * as ghost text in the reply box. It is still never *applied* — the agent puts it
 * in the box with Tab and sends it with Send, and nothing reaches a customer
 * without both — so what this table holds is a record of a suggestion and of a
 * person's decision about it, which is exactly the pair the report needs to say
 * whether the suggestions are any good.
 *
 * One row per agent, per ticket, per newest message (`anchor_message_id`). The
 * unique index on those three is the cache: an agent clicking in and out of the
 * same reply box is answered from here, and the provider is asked again only
 * when the conversation has moved on. It is also what makes two tabs racing the
 * same focus cost one call rather than two.
 *
 * Nothing reads this but the report. `canned_responses.usage_count` keeps
 * counting through the composer's existing pick, which an accepted suggestion
 * goes through like any other insert, so the ranking that column feeds cannot
 * tell — and does not need to know — whether a person or a model found the
 * response first.
 */
export const cannedSuggestions = pgTable(
  'canned_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Cascades: a purged ticket takes its suggestions, and its text, with it. */
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** Whose composer asked. Set null rather than cascade: the measurement outlives the account. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),

    /**
     * The newest reply on the ticket when the question was asked — the last
     * message of the history Jev was sent, so it is the cache key: the same
     * anchor means the same input. Set null on delete, the
     * `ai_category_runs.message_id` convention.
     */
    anchorMessageId: uuid('anchor_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),

    /** Frozen, so the report breaks down by channel without joining a ticket that may move. */
    channel: channelEnum('channel').notNull(),

    /**
     * The customer's language as the inbox page reads it (`detectLocale` on the
     * newest inbound message). The report splits on it, because a suggester that
     * works for English and not for Arabic is the systematic gap a total hides.
     */
    customerLocale: text('customer_locale'),

    /**
     * Which wording of the question produced this row — `REQUEST_VERSION` in
     * `lib/canned-suggest/request.ts`. Changing the instructions changes what is
     * being measured, and a report that cannot tell the two apart averages them.
     */
    requestVersion: text('request_version').notNull(),

    /** How many messages of history went with the question. */
    historyCount: smallint('history_count').notNull().default(0),

    /**
     * The canned responses Jev was offered, in the order the request keyed them.
     * Answers "was what the agent sent even on the list?" — a personal response
     * written after the suggestion, or a team's the agent joined later, was not.
     */
    offeredIds: uuid('offered_ids').array().notNull().default([]),

    /** The model that answered, from the response — `jev-latest` is an alias and moves. */
    model: text('model'),

    /**
     * What Jev chose: a canned response's id as text, or `none`.
     *
     * Text, and frozen, because canned responses are hard-deleted
     * (`deleteCannedResponse`): the foreign key below goes null when one is, and
     * the report still has to be able to say this row was a suggestion and not a
     * `none`. Null while the call is in flight, and when it failed.
     */
    choice: text('choice'),

    /** The live link, for the current title. Null for `none`, a failure, or a deleted response. */
    cannedResponseId: uuid('canned_response_id').references(() => cannedResponses.id, {
      onDelete: 'set null',
    }),

    /** The title as it was when suggested, for when the response has since gone. */
    cannedTitle: text('canned_title'),

    /** The winner's own share of the distribution. */
    probability: doublePrecision('probability'),

    /** TypeSafe's statistic over the whole distribution. */
    confidence: doublePrecision('confidence'),

    /**
     * Every option's share, keyed by canned response id or `none` — never by the
     * positional key the request used, which means a different response in every
     * request. Kept whole so a threshold can be swept afterwards without asking
     * again: whether to hide suggestions Jev was unsure of is a question this
     * column answers and v1 does not.
     */
    probabilities: jsonb('probabilities').$type<Record<string, number>>().notNull().default({}),

    /** Measured, not estimated — the two figures any decision about cost will want. */
    inputTokens: integer('input_tokens'),
    latencyMs: integer('latency_ms'),

    /** Why there is no choice. A failure is recorded, so a failure rate is something the report can print. */
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** When Jev answered, or the call failed. Null is in flight — or abandoned by a process that died. */
    settledAt: timestamp('settled_at', { withTimezone: true }),

    /**
     * When the ghost text first appeared in an empty reply box. A suggestion that
     * came back after the agent had started typing was never seen, and counting it
     * in the acceptance rate would score Jev on choices nobody was offered.
     */
    shownAt: timestamp('shown_at', { withTimezone: true }),

    /** When the agent took it — Tab, or the Use button on a phone. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),

    /** When the agent waved it away with Esc or ×. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),

    /** The reply this suggestion ended in. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),

    /** When that reply was sent. Survives the message link going null. */
    repliedAt: timestamp('replied_at', { withTimezone: true }),

    /**
     * Which canned response the sent reply actually carried — through this
     * suggestion or the picker, whichever the agent used last. The ground truth
     * the report scores Jev against.
     */
    sentCannedResponseId: uuid('sent_canned_response_id').references(() => cannedResponses.id, {
      onDelete: 'set null',
    }),
    sentCannedTitle: text('sent_canned_title'),
    sentLocale: text('sent_locale'),

    /**
     * Whether Jev was right: its choice equals what the reply carried, `none`
     * included — a reply written from scratch after Jev said `none` is a match.
     * Frozen when the reply is linked, so deleting a canned response later does
     * not re-grade history.
     */
    sentMatches: boolean('sent_matches'),

    /** How much of the suggested text survived, when the reply carried it. */
    sentEdit: suggestionEditEnum('sent_edit'),
  },
  (t) => [
    // The cache, the race guard and — by its leading column — the cascade's index.
    uniqueIndex('canned_suggestions_anchor_idx').on(t.conversationId, t.agentId, t.anchorMessageId),
    index('canned_suggestions_created_idx').on(t.createdAt),
    index('canned_suggestions_canned_idx').on(t.cannedResponseId),
    index('canned_suggestions_sent_canned_idx').on(t.sentCannedResponseId),
    // One suggestion per reply: a resubmitted send cannot link a second.
    uniqueIndex('canned_suggestions_message_idx').on(t.messageId),
  ],
);

/**
 * Whether the composer asks Jev at all.
 *
 * Its own switch rather than the presence of `TYPESAFE_API_KEY`, which is how the
 * shadow categoriser is gated: production already holds that key for the shadow
 * run, so key-as-flag would have switched suggestions on for every agent the
 * moment the code deployed. The key is a precondition; this is the decision.
 *
 * One row, pinned to `id = 1` by `db/sql/003_constraints.sql`, the
 * `presence_policy` shape. No row is the resting state of a fresh install and
 * reads as off, so staging — which also holds a key — stays off until somebody
 * turns it on there.
 */
export const cannedSuggestionSettings = pgTable('canned_suggestion_settings', {
  id: integer('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAgentId: uuid('updated_by_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
});
