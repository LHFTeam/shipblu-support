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
import { channels, ticketStatuses, slaPolicies } from './config';
import { contacts } from './customers';
import {
  channelEnum,
  deliveryStatusEnum,
  directionEnum,
  messageKindEnum,
  priorityEnum,
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

    // --- SLA ------------------------------------------------------------
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
    nextResponseDueAt: timestamp('next_response_due_at', { withTimezone: true }),
    resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    firstResponseBreached: boolean('first_response_breached').notNull().default(false),
    resolutionBreached: boolean('resolution_breached').notNull().default(false),

    // --- Activity timestamps, denormalised for inbox sorting -------------
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    lastCustomerMessageAt: timestamp('last_customer_message_at', { withTimezone: true }),
    lastAgentMessageAt: timestamp('last_agent_message_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

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
    index('conversations_channel_idx').on(t.channel, t.lastMessageAt),
    index('conversations_tags_idx').using('gin', t.tags),
    index('conversations_search_idx').using('gin', t.searchVector),

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
