import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { conversations, messages, tsvector } from './conversations';
import {
  channelEnum,
  deliveryStatusEnum,
  directionEnum,
  internalRecipientKindEnum,
  sideConversationStateEnum,
} from './enums';

/**
 * Side conversations: a thread with an internal third party, hanging off a
 * ticket, that the customer never sees.
 *
 * The shape of the work this exists for: a parcel is late, it is sitting in the
 * Downtown hub, and the answer the recipient wants is not in this system. The
 * agent emails the hub's forwarding list, someone on that team replies with what
 * actually happened, and only then can the ticket be answered. Before this the
 * exchange lived in an agent's personal mailbox, which meant the ticket was not
 * the record, nobody could measure how long hubs take, and the customer was one
 * Reply-All away from reading it.
 *
 * ## Why these are not `conversations` rows
 *
 * `conversations.parent_id` exists and is unused, and giving a side conversation
 * its own channel value would have been the smaller diff. It fails on two
 * counts, and both are the kind of failure that reports success:
 *
 *  - **Every read would have to exclude them.** The inbox query, `inboxCounts`,
 *    the customer, shipment and account pages, `lib/reports`, the nightly
 *    rollup, the SLA sweep, time-based automations, the customer portal and the
 *    widget. `lib/tickets/channel-policy.ts` was written because a rule spread
 *    across ten files gets enforced in nine of them after the next change; this
 *    would have been that rule again, with a customer-visible leak at the end of
 *    it. A query that does not name `side_conversation_messages` cannot return
 *    one, which is a guarantee rather than a discipline.
 *
 *  - **`conversations.requester_contact_id` is NOT NULL.** Reusing the table
 *    means writing a hub employee into `contacts`, where they turn up in the
 *    customer list, can be attached to shipping accounts, and can register for
 *    the portal. The counterparty here is a colleague, not a customer, and the
 *    schema should not have to be told the difference every time it is queried.
 *
 * ## Naming
 *
 * "Side conversation" is what the field calls this — Zendesk ships the feature
 * under that name. Freshworks calls its equivalent a *forward thread* and
 * anchors each one to a message in the ticket, which is the good idea borrowed
 * here as `anchor_message_id`.
 */

/**
 * The directory of internal parties an agent can write to.
 *
 * The alternative was a free-text address on every send, and the difference
 * between the two is the difference between a typo being a nuisance and a typo
 * being a data leak: `hub-downton@shipblu.com` reaches whoever registered that
 * domain, carrying a customer's address and their parcel history. A picker also
 * settles "which address is the Downtown hub?" once, in a place an admin can
 * correct, instead of once per agent in tribal memory.
 *
 * Free text is still allowed for the genuinely ad-hoc case, and is checked
 * against the ticket's own requester before it is accepted — see
 * `lib/side-conversations/guard.ts`.
 */
export const internalRecipients = pgTable(
  'internal_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),

    /**
     * Lowercased on every write and lookup, the same discipline
     * `contact_identities` needs from `lib/auth/normalise.ts` — the unique index
     * below is only usable if both sides agree on the canonical form.
     */
    email: text('email').notNull(),

    kind: internalRecipientKindEnum('kind').notNull().default('hub'),
    description: text('description'),

    /**
     * A retired hub keeps its history and disappears from the picker. Deleting
     * the row would blank the recipient on every side conversation ever sent to
     * it, which is why `side_conversations` also keeps the addresses it actually
     * sent to.
     */
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('internal_recipients_email_idx').on(t.email),
    uniqueIndex('internal_recipients_name_idx').on(t.name),
    index('internal_recipients_kind_idx').on(t.kind, t.name),
  ],
);

export const sideConversations = pgTable(
  'side_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The reply token's subject, and the anchor a timeline card links to.
     *
     * A serial rather than the uuid because the token travels in an email
     * local-part: `support+s<uuid without dashes>.<16 hex>@…` is 59 characters
     * against RFC 5321's 64-octet budget for a local part, before the mailbox
     * name. A small integer plus its HMAC is the same shape the ticket reply
     * token already uses and leaves room to spare.
     */
    number: bigserial('number', { mode: 'number' }).notNull(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /**
     * The message that prompted the question — Freshworks' "anchor".
     *
     * Nullable and `set null`: it is provenance, not structure. It answers "what
     * was the customer saying when we asked the hub about this?", and it is what
     * the composer quotes into the outbound body.
     */
    anchorMessageId: uuid('anchor_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),

    /**
     * Email today. The column exists so that reaching a hub leader on WhatsApp —
     * which is how a good deal of Egyptian operational traffic actually moves —
     * is a handler and a send path rather than a migration on a table that has
     * started to carry real history.
     */
    channel: channelEnum('channel').notNull().default('email'),

    subject: text('subject').notNull(),

    state: sideConversationStateEnum('state').notNull().default('open'),

    /** Null when the agent typed an address instead of picking from the list. */
    recipientId: uuid('recipient_id').references(() => internalRecipients.id, {
      onDelete: 'set null',
    }),

    /**
     * Where it was actually sent, resolved at send time.
     *
     * Denormalised deliberately: an admin correcting the Downtown hub's address
     * next month must not rewrite what last month's thread says it was sent to.
     * The link to `internal_recipients` is for grouping and reporting; this is
     * the record.
     */
    toAddresses: text('to_addresses').array().notNull().default([]),
    ccAddresses: text('cc_addresses').array().notNull().default([]),

    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * When the other side last wrote. Null until they answer at all, which is
     * exactly the distinction the "awaiting reply · 2h" badge needs: never
     * answered and answered-then-quiet look identical without it.
     */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedByAgentId: uuid('closed_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('side_conversations_number_idx').on(t.number),
    // Every render of a ticket: this ticket's threads, oldest first.
    index('side_conversations_conversation_idx').on(t.conversationId, t.createdAt),
    // "What is still waiting on somebody", for the future internal-wait report.
    index('side_conversations_state_idx').on(t.state, t.lastMessageAt),
    index('side_conversations_recipient_idx').on(t.recipientId),
  ],
);

export const sideConversationMessages = pgTable(
  'side_conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sideConversationId: uuid('side_conversation_id')
      .notNull()
      .references(() => sideConversations.id, { onDelete: 'cascade' }),

    /** `outbound` is us asking; `inbound` is the hub answering. */
    direction: directionEnum('direction').notNull(),

    /** Null on inbound — nobody here wrote it. */
    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),

    /**
     * Who on the other side actually replied.
     *
     * The most useful pair of columns on the table. The thread is addressed to a
     * forwarding list, so "Downtown Hub" is all the recipient ever tells you;
     * this is what turns the answer into "Ahmed from Downtown said so at 14:12",
     * which is what an agent needs when the customer asks who promised what.
     */
    fromAddress: text('from_address'),
    fromName: text('from_name'),

    toAddresses: text('to_addresses').array().notNull().default([]),
    ccAddresses: text('cc_addresses').array().notNull().default([]),

    bodyHtml: text('body_html'),
    bodyText: text('body_text').notNull().default(''),
    /** Before quoted-reply stripping, so a stripping bug is never lossy. */
    rawBody: text('raw_body'),

    /** RFC 5322 Message-ID. Idempotency, and what a reply's References quotes. */
    channelMessageId: text('channel_message_id'),
    inReplyTo: text('in_reply_to'),

    deliveryStatus: deliveryStatusEnum('delivery_status').notNull().default('pending'),
    deliveryError: text('delivery_error'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),

    /** SPF/DKIM verdicts, the automation classification, which stripper matched. */
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(body_text, ''))`,
    ),
  },
  (t) => [
    index('side_conversation_messages_thread_idx').on(t.sideConversationId, t.createdAt),
    // Idempotency: a redelivered webhook must never append the hub's answer
    // twice. Separate from the index of the same name on `messages` because the
    // two tables are searched separately, side first.
    uniqueIndex('side_conversation_messages_channel_idx').on(t.channelMessageId),
    index('side_conversation_messages_search_idx').using('gin', t.searchVector),
    index('side_conversation_messages_delivery_idx').on(t.deliveryStatus),
  ],
);

export const internalRecipientsRelations = relations(internalRecipients, ({ many }) => ({
  sideConversations: many(sideConversations),
}));

export const sideConversationsRelations = relations(sideConversations, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [sideConversations.conversationId],
    references: [conversations.id],
  }),
  anchorMessage: one(messages, {
    fields: [sideConversations.anchorMessageId],
    references: [messages.id],
  }),
  recipient: one(internalRecipients, {
    fields: [sideConversations.recipientId],
    references: [internalRecipients.id],
  }),
  createdBy: one(agents, {
    fields: [sideConversations.createdByAgentId],
    references: [agents.id],
  }),
  messages: many(sideConversationMessages),
}));

export const sideConversationMessagesRelations = relations(sideConversationMessages, ({ one }) => ({
  sideConversation: one(sideConversations, {
    fields: [sideConversationMessages.sideConversationId],
    references: [sideConversations.id],
  }),
  authorAgent: one(agents, {
    fields: [sideConversationMessages.authorAgentId],
    references: [agents.id],
  }),
}));
