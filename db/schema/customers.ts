import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channelEnum, sourceSystemEnum } from './enums';

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),

    /** Inbound mail from these domains auto-associates to this company. */
    domains: text('domains').array().notNull().default([]),

    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('companies_name_idx').on(t.name),
    uniqueIndex('companies_external_idx').on(t.sourceSystem, t.externalId),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),

    /**
     * Convenience denormalisation for display and search. The authoritative,
     * per-channel addresses live in `contact_identities`.
     */
    primaryEmail: text('primary_email'),
    primaryPhone: text('primary_phone'),

    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    timezone: text('timezone'),
    locale: text('locale').notNull().default('en'),

    customFields: jsonb('custom_fields').$type<Record<string, unknown>>().notNull().default({}),

    /** Excluded from the inbox and never auto-replied to. */
    isBlocked: boolean('is_blocked').notNull().default(false),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('contacts_company_idx').on(t.companyId),
    index('contacts_primary_email_idx').on(t.primaryEmail),
    uniqueIndex('contacts_external_idx').on(t.sourceSystem, t.externalId),
  ],
);

/**
 * The table that makes the unified inbox real: one customer, many per-channel
 * addresses. An inbound message is resolved to a contact by looking up
 * `(channel, identifier)` here, so an email thread and a WhatsApp chat from the
 * same person land on the same customer record.
 *
 * `identifier` is normalised per channel — lowercased for email, E.164 for
 * WhatsApp, raw scoped id for Facebook/Instagram.
 */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    channel: channelEnum('channel').notNull(),
    identifier: text('identifier').notNull(),

    /** Display name as reported by the channel, e.g. the WhatsApp profile name. */
    displayName: text('display_name'),

    /** True once the customer has proven control (clicked a verification link). */
    isVerified: boolean('is_verified').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One identity per (channel, identifier) globally — two contacts must never
    // claim the same WhatsApp number or email address.
    uniqueIndex('contact_identities_channel_identifier_idx').on(t.channel, t.identifier),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

export const companiesRelations = relations(companies, ({ many }) => ({
  contacts: many(contacts),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  identities: many(contactIdentities),
}));

export const contactIdentitiesRelations = relations(contactIdentities, ({ one }) => ({
  contact: one(contacts, { fields: [contactIdentities.contactId], references: [contacts.id] }),
}));
