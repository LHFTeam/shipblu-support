import { relations } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { conversations, messages } from './conversations';
import { companies, contacts } from './customers';
import { linkSourceEnum, shipmentSyncStateEnum, sourceSystemEnum } from './enums';

/**
 * Shipments, shipping accounts, and what they are attached to.
 *
 * Almost every ticket this helpdesk handles is about a parcel, and until now the
 * only place a tracking number lived was the body of a message. That made the
 * one identifier the business runs on searchable only as free text — and
 * findable only in the tickets that happened to quote it, never in the reply
 * where the customer just said "still nothing".
 *
 * Three shapes, and the reasons they are shaped that way:
 *
 * - A **shipment** is created the moment a tracking number is seen, so it is
 *   almost always a stub: a number, and nothing else. `sync_state` says that out
 *   loud rather than leaving an agent to infer it from a screen full of nulls.
 *
 * - A **shipping account** is an SBID. It is not a `company`: `companies` groups
 *   people by email domain and gates knowledge base visibility, one merchant can
 *   hold several SBIDs, and a person can speak for several accounts. Hence its
 *   own table and its own many-to-many.
 *
 * - A conversation links to **both** shipments and shipping accounts, and the
 *   second link is the one that looks redundant and is not. Seeing "my account
 *   is SB-4471" in a message proves that the SBID was mentioned in this ticket.
 *   It does not prove the sender belongs to that account — a recipient quoting
 *   the merchant's number is ordinary — so a mention must never write
 *   `contact_shipping_accounts`, which is a claim about a person's identity.
 *
 * Note what is *not* here: no per-link "is the customer the shipper or the
 * recipient". That is a fact about (contact, shipment), which the shipment
 * already holds, and duplicating it onto the link creates a pair that disagree
 * the first time a sync corrects the shipment. `lib/shipments/roles.ts` derives
 * it instead.
 */

export const shippingAccounts = pgTable(
  'shipping_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The account number on the shipping platform, canonicalised by
     * `normaliseSbid()` at every write and every lookup. The unique index below
     * is only usable if both sides agree on the canonical form — the same
     * discipline `contact_identities` needs from `lib/auth/normalise.ts`.
     */
    sbid: text('sbid').notNull(),

    name: text('name'),

    /**
     * The support-side company, when there is one. Optional, and deliberately
     * not the same thing: an SBID is a billing relationship on another system.
     */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    syncState: shipmentSyncStateEnum('sync_state').notNull().default('stub'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipping_accounts_sbid_idx').on(t.sbid),
    uniqueIndex('shipping_accounts_external_idx').on(t.sourceSystem, t.externalId),
    index('shipping_accounts_company_idx').on(t.companyId),
  ],
);

/**
 * Which people can speak for which shipping accounts.
 *
 * Written only by an agent or by a future platform sync — never by the
 * detector, for the reason in the file docstring.
 *
 * No `(source_system, external_id)`: the natural key *is* the primary key, so a
 * sync is already idempotent without them. Adding them would mean inventing a
 * stable platform id for a membership the platform very likely does not expose,
 * which is a unique index that lies.
 */
export const contactShippingAccounts = pgTable(
  'contact_shipping_accounts',
  {
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    shippingAccountId: uuid('shipping_account_id')
      .notNull()
      .references(() => shippingAccounts.id, { onDelete: 'cascade' }),

    linkSource: linkSourceEnum('link_source').notNull().default('manual'),
    linkedByAgentId: uuid('linked_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.shippingAccountId] }),
    // The reverse direction: every person who can speak for this account.
    index('contact_shipping_accounts_account_idx').on(t.shippingAccountId),
  ],
);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Canonical form from `normaliseTrackingNumber()`. Uppercase, no separators. */
    trackingNumber: text('tracking_number').notNull(),

    shippingAccountId: uuid('shipping_account_id').references(() => shippingAccounts.id, {
      onDelete: 'set null',
    }),

    /**
     * The two parties, where either is a contact we already know. Both nullable,
     * and both meaningless while `sync_state` is `stub` — which is exactly why
     * `sync_state` exists rather than these being read as "no shipper".
     *
     * Never set by the detector. A number in a message says nothing about which
     * end of the parcel the sender is on.
     */
    shipperContactId: uuid('shipper_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),
    recipientContactId: uuid('recipient_contact_id').references(() => contacts.id, {
      onDelete: 'set null',
    }),

    /**
     * The platform's own words for where the parcel is, not an enum. That
     * vocabulary belongs to the shipping platform and will be renamed without
     * telling us; an enum would make every rename an ALTER TYPE migration.
     */
    statusLabel: text('status_label'),
    statusAt: timestamp('status_at', { withTimezone: true }),

    syncState: shipmentSyncStateEnum('sync_state').notNull().default('stub'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    /** Whatever else a future platform sync brings back. Nothing reads it yet. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipments_tracking_idx').on(t.trackingNumber),
    uniqueIndex('shipments_external_idx').on(t.sourceSystem, t.externalId),
    index('shipments_account_idx').on(t.shippingAccountId),
    index('shipments_shipper_idx').on(t.shipperContactId),
    index('shipments_recipient_idx').on(t.recipientContactId),
    // A future sync job's claim query: everything never synced, oldest first.
    index('shipments_sync_idx').on(t.syncState, t.createdAt),
  ],
);

export const conversationShipments = pgTable(
  'conversation_shipments',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),

    linkSource: linkSourceEnum('link_source').notNull().default('manual'),
    /** Which message it was found in — the provenance the sidebar shows. */
    detectedInMessageId: uuid('detected_in_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    linkedByAgentId: uuid('linked_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.shipmentId] }),
    // The whole of the future platform query — conversations for a shipment,
    // newest first — and what the shipment page renders.
    index('conversation_shipments_shipment_idx').on(t.shipmentId, t.createdAt),
  ],
);

/**
 * An SBID mentioned in a ticket.
 *
 * Separate from `contact_shipping_accounts` because they assert different
 * things, and only this one is safe to write from detected text.
 */
export const conversationShippingAccounts = pgTable(
  'conversation_shipping_accounts',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    shippingAccountId: uuid('shipping_account_id')
      .notNull()
      .references(() => shippingAccounts.id, { onDelete: 'cascade' }),

    linkSource: linkSourceEnum('link_source').notNull().default('manual'),
    detectedInMessageId: uuid('detected_in_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    linkedByAgentId: uuid('linked_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.shippingAccountId] }),
    index('conversation_shipping_accounts_account_idx').on(t.shippingAccountId, t.createdAt),
  ],
);

export const shippingAccountsRelations = relations(shippingAccounts, ({ one, many }) => ({
  company: one(companies, {
    fields: [shippingAccounts.companyId],
    references: [companies.id],
  }),
  shipments: many(shipments),
  contacts: many(contactShippingAccounts),
}));

export const contactShippingAccountsRelations = relations(contactShippingAccounts, ({ one }) => ({
  contact: one(contacts, {
    fields: [contactShippingAccounts.contactId],
    references: [contacts.id],
  }),
  shippingAccount: one(shippingAccounts, {
    fields: [contactShippingAccounts.shippingAccountId],
    references: [shippingAccounts.id],
  }),
}));

export const shipmentsRelations = relations(shipments, ({ one, many }) => ({
  shippingAccount: one(shippingAccounts, {
    fields: [shipments.shippingAccountId],
    references: [shippingAccounts.id],
  }),
  shipper: one(contacts, {
    fields: [shipments.shipperContactId],
    references: [contacts.id],
  }),
  recipient: one(contacts, {
    fields: [shipments.recipientContactId],
    references: [contacts.id],
  }),
  conversations: many(conversationShipments),
}));

export const conversationShipmentsRelations = relations(conversationShipments, ({ one }) => ({
  conversation: one(conversations, {
    fields: [conversationShipments.conversationId],
    references: [conversations.id],
  }),
  shipment: one(shipments, {
    fields: [conversationShipments.shipmentId],
    references: [shipments.id],
  }),
}));

export const conversationShippingAccountsRelations = relations(
  conversationShippingAccounts,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationShippingAccounts.conversationId],
      references: [conversations.id],
    }),
    shippingAccount: one(shippingAccounts, {
      fields: [conversationShippingAccounts.shippingAccountId],
      references: [shippingAccounts.id],
    }),
  }),
);
