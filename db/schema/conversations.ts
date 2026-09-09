import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  customType,
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
import { agents, groups } from './agents';
import { channels, ticketForms, ticketRootCauses, ticketStatuses, slaPolicies } from './config';
import { contacts } from './customers';
import {
  channelEnum,
  deliveryStatusEnum,
  directionEnum,
  messageKindEnum,
  priorityEnum,
  requesterKindEnum,
  sourceSystemEnum,
} from './enums';

/**
 * Postgres ships no Arabic text-search configuration, so everything is indexed
 * with 'simple' (no stemming) and paired with a pg_trgm index for fuzzy and
 * substring matching. That degrades English stemming slightly but is the only
 * option that works for both languages in one column.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Human-facing ticket number, shared across every channel. */
    number: bigserial('number', { mode: 'number' }).notNull(),

    subject: text('subject'),
    channel: channelEnum('channel').notNull(),
    channelId: uuid('channel_id').references(() => channels.id, { onDelete: 'set null' }),

    statusId: uuid('status_id')
      .notNull()
      .references(() => ticketStatuses.id, { onDelete: 'restrict' }),
    priority: priorityEnum('priority').notNull().default('medium'),
    /** Freshdesk "ticket type" — Question, Incident, Problem, and so on. */
    type: text('type'),

    /**
     * Which population this ticket came from.
     *
     * Detected on arrival from the requester's own record — a contact holding a
     * shipping account is a merchant — and falling back to the words they used.
     * A column rather than a derived read because it is single-valued and
     * because every report slices by it: merchants ask about payouts and
     * integrations, recipients ask where their parcel is, and averaging the two
     * describes neither.
     */
    requesterKind: requesterKindEnum('requester_kind'),

    /**
     * Why this ticket existed, recorded by the agent who resolved it.
     *
     * Null until then, and deliberately never written by the detector. The
     * customer reports a symptom; the cause is what somebody established by
     * looking, and inferring it from the complaint text would fill the one column
     * the team plans from with confident guesses. Which is also why it is a
     * column here rather than a row in `conversation_categories`: a ticket has
     * many things it is about and exactly one reason it happened.
     *
     * `restrict`, like `status_id`: a cause with history behind it is retired,
     * never deleted.
     */
    rootCauseId: uuid('root_cause_id').references(() => ticketRootCauses.id, {
      onDelete: 'restrict',
    }),

    /**
     * When the cause above was established, which is the day the cause report
     * counts it on.
     *
     * `resolved_at` was the obvious timestamp and it is the wrong one on its
     * own, because it is written **only** for a status in the `resolved`
     * category. An agent who picks `Closed` instead ends the ticket with
     * `resolved_at` still null, so a cause recorded there was stored and then
     * counted by nothing. Widening `resolved_at` to cover closing was the other
     * option and would have been worse: it feeds resolution-SLA attainment
     * (`lib/sla/index.ts`) and the agents report's resolved counts
     * (`lib/reports/agent-rollup.ts`), and closing a ticket is not resolving it.
     *
     * So the cause carries its own instant, and `computeRootCauseDay` counts
     * from `coalesce(resolved_at, root_cause_set_at)`. That also happens to be
     * a more literal reading of what the report claims to measure — the day
     * somebody worked it out — than the day the ticket was closed.
     */
    rootCauseSetAt: timestamp('root_cause_set_at', { withTimezone: true }),

    requesterContactId: uuid('requester_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /**
     * When the current assignee got it. Null whenever `assigneeAgentId` is.
     *
     * Not derivable from the timeline: `conversation_events` is swept for
     * nothing today but it is an append-only log meant for reading, and the
     * reclaim pass asks this question of every live ticket every five minutes.
     */
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),

    tags: text('tags').array().notNull().default([]),
    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * The form this ticket was submitted through, when it was.
     *
     * Kept on the row rather than inferred from which custom fields happen to be
     * filled in: two forms can ask the same questions, and an answer set is not
     * an identity. It is what lets the console say where a ticket came from,
     * what lets reporting group by it, and what `form.slug` in
     * `lib/rules/facts.ts` reads so an automation can route on the form without
     * re-deriving it.
     *
     * `set null` rather than `restrict`: deleting a retired form must not be
     * blocked by the tickets it opened, and a ticket whose form is gone is still
     * a ticket.
     */
    formId: uuid('form_id').references(() => ticketForms.id, { onDelete: 'set null' }),

    // --- SLA ------------------------------------------------------------
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    nextResponseDueAt: timestamp('next_response_due_at', { withTimezone: true }),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    /**
     * When software first answered, which is never a first response.
     *
     * Deliberately a second column rather than a flag on `firstRespondedAt`:
     * the reports, the rollup and the breach sweep all read that one and must
     * keep counting an auto-acknowledged ticket as awaiting its first reply.
     * What this column exists for is the rule engine, which needs to know the
     * acknowledgement already went out — an automation whose condition only a
     * human can clear re-sends it every time the sweep comes round.
     */
    firstAutoRepliedAt: timestamp('first_auto_replied_at', { withTimezone: true }),
    firstResponseBreached: boolean('first_response_breached').notNull().default(false),
    resolutionBreached: boolean('resolution_breached').notNull().default(false),

    // --- Activity timestamps, denormalised for inbox sorting -------------
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true }),
    lastAgentMessageAt: timestamp('last_agent_message_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /**
     * Who moved it into a resolved status, as opposed to who holds it now.
     *
     * Those are the same person for most tickets and different for exactly the
     * ones a reopen rate is supposed to catch. Reporting cannot use
     * `assigneeAgentId` for "whose resolution came back": a ticket handed on
     * after the fact would move the mark to somebody who never closed it, and
     * because the nightly rollup rebuilds the last three days, the same day's
     * figure would change depending on when it happened to be recomputed.
     *
     * Null when nobody clicked anything — an automation resolved it, or it
     * predates this column. Null is deliberately not "the assignee": an
     * unattributed resolution is a real answer, and guessing would put a
     * customer coming back on the record of whoever happened to be holding it.
     *
     * Overwritten by each resolve, never cleared by a reopen, so a ticket
     * resolved by one agent and re-resolved by another attributes each
     * reopening to the person whose work it followed.
     */
    resolvedByAgentId: uuid('resolved_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    /**
     * When an out-of-hours acknowledgement last went out on this ticket.
     *
     * Here rather than derived from the timeline because it is a claim, not a
     * record: `lib/auto-response` writes it with a conditional update and only
     * sends if that update matched, so a customer sending six messages at
     * 23:00 — six ingest jobs, running in parallel on the worker — gets one
     * reply rather than six. Scanning `messages` for the last one instead
     * would leave exactly that race open.
     *
     * Not cleared when the office reopens. "Has the office opened since this
     * instant?" is a question `lib/hours` already answers, and a timestamp that
     * something has to remember to reset is a timestamp that will be wrong.
     */
    autoRespondedAt: timestamp('auto_responded_at', { withTimezone: true }),

    /** Number of times the ticket has moved back out of a resolved status. */
    reopenCount: integer('reopen_count').notNull().default(0),

    // --- Relationships ---------------------------------------------------
    parentId: uuid('parent_id').references((): AnyPgColumn => conversations.id, {
      onDelete: 'set null',
    }),
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => conversations.id, {
      onDelete: 'set null',
    }),

    isSpam: boolean('is_spam').notNull().default(false),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(subject, ''))`,
    ),
  },
  (t) => [
    uniqueIndex('conversations_number_idx').on(t.number),
    uniqueIndex('conversations_external_idx').on(t.sourceSystem, t.externalId),

    // The inbox's default query: open tickets for a group, newest activity first.
    index('conversations_inbox_idx').on(t.statusId, t.groupId, t.lastMessageAt),
    index('conversations_assignee_idx').on(t.assigneeAgentId, t.lastMessageAt),
    index('conversations_requester_idx').on(t.requesterContactId),
    index('conversations_form_idx').on(t.formId, t.createdAt),
    index('conversations_channel_idx').on(t.channel, t.lastMessageAt),
    index('conversations_tags_idx').using('gin', t.tags),
    index('conversations_search_idx').using('gin', t.searchVector),

    // The two foreign keys that are joined on by themselves rather than as part
    // of an inbox filter. `conversations_inbox_idx` above leads on `status_id`,
    // so it cannot drive a join keyed on the group alone — and the assignment
    // sweep does exactly that, every five minutes: 5,821 runs at 24.1 ms is
    // 140 s, the most expensive statement this application issues. That cost
    // grows with the ticket count rather than with traffic, so it is the one
    // figure here that gets worse on its own as the system goes live.
    index('conversations_group_idx').on(t.groupId),
    index('conversations_channel_id_idx').on(t.channelId),

    // Drives the SLA sweep: only rows with a live due date and no breach flag.
    index('conversations_sla_due_idx').on(t.resolutionDueAt),
    index('conversations_first_response_due_idx').on(t.firstResponseDueAt),

    // The three timestamps a day of metrics is cut by. The nightly rollup could
    // afford to scan for them; the live dashboard recomputes today on every
    // refresh, which turns a nightly sequential scan into a continuous one.
    index('conversations_created_idx').on(t.createdAt),
    index('conversations_resolved_idx').on(t.resolvedAt),
    index('conversations_first_responded_idx').on(t.firstRespondedAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    direction: directionEnum('direction').notNull(),
    kind: messageKindEnum('kind').notNull().default('reply'),

    /** Exactly one of these is set for reply/note; both null for system entries. */
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    authorContactId: uuid('author_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),

    bodyHtml: text('body_html'),
    bodyText: text('body_text').notNull().default(''),

    /**
     * The full original body before quoted-reply stripping. Kept so an agent can
     * expand the trimmed content, and so a stripping bug is never lossy.
     */
    rawBody: text('raw_body'),

    /** Provider's id — Message-ID for email, wamid for WhatsApp. */
    channelMessageId: text('channel_message_id'),
    /** Email In-Reply-To / References chain, used for threading. */
    inReplyTo: text('in_reply_to'),

    /** Recipients for email; each is a list of addresses. */
    toAddresses: text('to_addresses').array().notNull().default([]),
    ccAddresses: text('cc_addresses').array().notNull().default([]),
    bccAddresses: text('bcc_addresses').array().notNull().default([]),
    fromAddress: text('from_address'),

    deliveryStatus: deliveryStatusEnum('delivery_status').notNull().default('pending'),
    deliveryError: text('delivery_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),

    /** Channel-specific extras: WhatsApp template used, Meta media ids, headers. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(body_text, ''))`,
    ),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    // Idempotency: the same provider message must never be ingested twice.
    uniqueIndex('messages_channel_message_idx').on(t.channelMessageId),
    uniqueIndex('messages_external_idx').on(t.sourceSystem, t.externalId),
    index('messages_search_idx').using('gin', t.searchVector),
    index('messages_delivery_idx').on(t.deliveryStatus),

    // Both authorship columns, joined from the agent and contact side rather
    // than filtered within a conversation. Unindexed until now, on the table
    // that grows fastest — which is also why they are worth the write cost
    // here and the other 38 unindexed foreign keys the advisor lists are not:
    // those serve admin screens, and 43 new indexes would tax every insert to
    // speed up pages nobody opens.
    index('messages_author_agent_idx').on(t.authorAgentId),
    index('messages_author_contact_idx').on(t.authorContactId),
    // Volume-through-the-day on the dashboard filters on nothing else, and this
    // is the table that grows fastest.
    index('messages_created_idx').on(t.createdAt),
  ],
);

/**
 * A file on a message — on a ticket message, or on a side conversation message.
 *
 * One table with two nullable owners rather than two tables, because everything
 * downstream of the row is identical: the same private bucket, the same derived
 * storage path, the same signed-URL route. A second table would have meant a
 * second copy of `app/api/attachments/[id]/route.ts`, and the copy that drifts
 * is the one that serves a file to someone who should not have it.
 *
 * Exactly one of `message_id` / `side_message_id` is set, enforced by a CHECK in
 * `db/sql/001_extensions_and_triggers.sql` — Drizzle's DSL cannot express it,
 * and leaving it to application code would make "both null" a row that no query
 * ever finds and no cascade ever deletes.
 *
 * The reference to `side_conversation_messages` is added in SQL for the same
 * reason `groups.business_hours_id` is: side-conversations.ts imports this
 * module, so declaring the column against it here would make the two circular.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    /** Set instead of `messageId` when the file came in on a side conversation. */
    sideMessageId: uuid('side_message_id'),

    /** Object key inside the Supabase Storage bucket. */
    storagePath: text('storage_path').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksum: text('checksum'),

    /** Inline images referenced from body HTML by cid:. */
    contentId: text('content_id'),
    isInline: boolean('is_inline').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_side_message_idx').on(t.sideMessageId),
  ],
);

/** Append-only audit trail powering the ticket activity feed. */
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** e.g. status_changed, assigned, tagged, merged, sla_breached, priority_changed */
    type: text('type').notNull(),
    /** Null when the actor is the system (an automation or SLA sweep). */
    actorAgentId: uuid('actor_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    /** Names the automation rule or job when actorAgentId is null. */
    actorLabel: text('actor_label'),

    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_events_conversation_idx').on(t.conversationId, t.createdAt),
    // Reopenings are counted by type across a date range, which the
    // per-conversation index cannot serve.
    index('conversation_events_type_idx').on(t.type, t.createdAt),
    // And the agent rollup asks for a whole day of events regardless of type,
    // to count every ticket somebody touched. A leading `type` cannot serve
    // that, so this is the plain date index `messages` already carries for the
    // same reason.
    index('conversation_events_created_idx').on(t.createdAt),
    // Who acted, joined from the agent side. The agent productivity report
    // counts a day of events per person, which neither the type nor the date
    // index can narrow.
    index('conversation_events_actor_idx').on(t.actorAgentId),
  ],
);

export const conversationWatchers = pgTable(
  'conversation_watchers',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.agentId] }),
    index('conversation_watchers_agent_idx').on(t.agentId),
  ],
);

/**
 * Collision detection: who is looking at or typing in a ticket right now.
 * High-churn and disposable — rows are swept by a cron job, and losing the table
 * entirely would cost nothing but a moment of stale presence.
 */
export const conversationPresence = pgTable(
  'conversation_presence',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    isTyping: boolean('is_typing').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.agentId] }),
    index('conversation_presence_updated_idx').on(t.updatedAt),
  ],
);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  requester: one(contacts, {
    fields: [conversations.requesterContactId],
    references: [contacts.id],
  }),
  assignee: one(agents, { fields: [conversations.assigneeAgentId], references: [agents.id] }),
  group: one(groups, { fields: [conversations.groupId], references: [groups.id] }),
  status: one(ticketStatuses, {
    fields: [conversations.statusId],
    references: [ticketStatuses.id],
  }),
  messages: many(messages),
  events: many(conversationEvents),
  watchers: many(conversationWatchers),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  authorAgent: one(agents, { fields: [messages.authorAgentId], references: [agents.id] }),
  authorContact: one(contacts, { fields: [messages.authorContactId], references: [contacts.id] }),
  attachments: many(attachments),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  message: one(messages, { fields: [attachments.messageId], references: [messages.id] }),
}));
