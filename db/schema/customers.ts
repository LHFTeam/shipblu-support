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
import { channelEnum, contactTokenPurposeEnum, sourceSystemEnum } from './enums';

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

    /**
     * Which side of a parcel this person is usually on. Both can be true — a
     * merchant who also receives returns is both, and that is the common case
     * for anyone who ships at all.
     *
     * Maintained by `refreshContactRoles()` from the relationship tables (you
     * are a shipper because you hold a shipping account, a recipient because a
     * shipment names you), and settable by an agent on the contact page.
     * Automatic maintenance is deliberately **additive**: it turns a flag on
     * when it can prove it and never off, so a platform sync can never silently
     * undo a designation a person made.
     *
     * A cache, not the truth. The relationship rows are the truth, and every
     * screen that shows detail shows them.
     */
    isShipper: boolean('is_shipper').notNull().default(false),
    isRecipient: boolean('is_recipient').notNull().default(false),

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

    /**
     * argon2id, for the customer portal. Null on nearly every row: a person who
     * has only ever emailed support has an identity here and no sign-in, and
     * only ever needs one if they want to read their tickets on the web.
     *
     * The credential hangs off the *identity* rather than the contact because
     * that is what it proves — control of one address. `is_verified` above is
     * the other half: a password on an unverified identity cannot sign in, so
     * registering with a stranger's address gets an attacker nothing.
     */
    passwordHash: text('password_hash'),
    passwordSetAt: timestamp('password_set_at', { withTimezone: true }),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One identity per (channel, identifier) globally — two contacts must never
    // claim the same WhatsApp number or email address.
    uniqueIndex('contact_identities_channel_identifier_idx').on(t.channel, t.identifier),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

/**
 * Customer portal sessions.
 *
 * A separate table and a separate cookie from `sessions`, which is the agent
 * console's. Two populations with different lifetimes, different revocation
 * rules and very different blast radius should not share a row space where one
 * missed `where` clause turns a customer's cookie into an agent's — and keeping
 * them apart means a person who is both (a colleague who also emails support)
 * can hold both at once without either signing the other out.
 */
export const contactSessions = pgTable(
  'contact_sessions',
  {
    /** SHA-256 of the cookie value. The raw token is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    index('contact_sessions_identity_idx').on(t.identityId),
    index('contact_sessions_expires_idx').on(t.expiresAt),
  ],
);

/** Single-use email-verification and password-reset links for the portal. */
export const contactTokens = pgTable(
  'contact_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => contactIdentities.id, { onDelete: 'cascade' }),
    purpose: contactTokenPurposeEnum('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contact_tokens_identity_idx').on(t.identityId, t.purpose),
    index('contact_tokens_expires_idx').on(t.expiresAt),
  ],
);

export const companiesRelations = relations(companies, ({ many }) => ({
  contacts: many(contacts),
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  identities: many(contactIdentities),
}));

export const contactIdentitiesRelations = relations(contactIdentities, ({ one, many }) => ({
  contact: one(contacts, { fields: [contactIdentities.contactId], references: [contacts.id] }),
  sessions: many(contactSessions),
}));

export const contactSessionsRelations = relations(contactSessions, ({ one }) => ({
  identity: one(contactIdentities, {
    fields: [contactSessions.identityId],
    references: [contactIdentities.id],
  }),
}));
