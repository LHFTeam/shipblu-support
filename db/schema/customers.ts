import {
  type AnyPgColumn,
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

    /**
     * Storage key for the customer's profile picture, or null when we have
     * never been given one.
     *
     * A key rather than a URL. Meta hands over `profile_pic` as a signed CDN
     * link that expires, so a stored URL is a broken image on a timer — the same
     * reason `download_media` copies attachments the moment they arrive. The
     * bytes are copied into our own bucket and served through
     * `/api/contacts/[id]/avatar`, which mints a short-lived signed URL per view
     * because the bucket is private and stays that way.
     *
     * A cache of whatever channel last told us, not an identity: it is display
     * only, nothing keys off it, and a contact with several channels simply
     * shows the most recent picture any of them supplied.
     */
    avatarPath: text('avatar_path'),

    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),

    timezone: text('timezone'),
    locale: text('locale').notNull().default('en'),

    /**
     * 'male' or 'female' as Messenger reported it, or null — which is both "we
     * have never been told" and "they have not set one". Meta omits the field
     * for anyone who has chosen a custom gender or none, so there is no third
     * value to store; `normaliseGender()` drops anything else rather than
     * putting a raw Graph token in front of an agent.
     *
     * Free text rather than an enum on purpose. An enum would have to be
     * migrated to admit a value some future channel reports, and this column
     * exists to be *displayed*, never to be branched on — nothing in this
     * system changes behaviour based on it, and nothing should.
     */
    gender: text('gender'),

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

    /**
     * Set when this contact was merged into another one, which is the same row
     * carrying `deletedAt`. A merged contact is a **tombstone**, not a deletion:
     * everything that referenced it now references the survivor, and this
     * pointer is what still answers "where did that person go?" for a
     * bookmarked link, an imported id, or an agent who remembers the wrong one.
     *
     * `conversations.merged_into_id` is the precedent, and the reasoning is the
     * same. Hard-deleting the loser instead would take its `(source_system,
     * external_id)` with it, so the next importer run would recreate the
     * duplicate we just merged away.
     */
    mergedIntoContactId: uuid('merged_into_contact_id').references((): AnyPgColumn => contacts.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('contacts_company_idx').on(t.companyId),
    index('contacts_primary_email_idx').on(t.primaryEmail),
    uniqueIndex('contacts_external_idx').on(t.sourceSystem, t.externalId),
    // "Which duplicates were folded into this person?" — asked by the contact
    // page on every render, and by nothing else.
    index('contacts_merged_into_idx').on(t.mergedIntoContactId),
  ],
);

/**
 * What one merge moved.
 *
 * Counts rather than ids: the row is there to say "this merge happened, by this
 * person, and it was this big", which is what somebody reading a surprising
 * contact history needs. The ids of everything that moved are recoverable from
 * the rows themselves — they all point at the survivor now.
 */
export type MergedCounts = {
  identities: number;
  conversations: number;
  messages: number;
  shippingAccounts: number;
  shipments: number;
};

/**
 * The audit trail for contact merges.
 *
 * A merge is the one write in this system that moves another person's tickets
 * onto a contact, so it gets a row of its own rather than only the tombstone
 * pointer. `deletedAt` plus `merged_into_contact_id` says *that* it happened;
 * this says who did it, when, and how much moved — the three questions asked
 * when a merge turns out to have been wrong.
 *
 * Unique on `merged_contact_id`: a contact can be merged away exactly once,
 * because the second attempt has nothing left to move. The index is the guard,
 * not the check in `mergeContacts()`.
 */
export const contactMerges = pgTable(
  'contact_merges',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    survivorContactId: uuid('survivor_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    mergedContactId: uuid('merged_contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),

    /** Null once the agent who did it has been deleted; the merge still stands. */
    mergedByAgentId: uuid('merged_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),

    moved: jsonb('moved').$type<MergedCounts>().notNull().default({
      identities: 0,
      conversations: 0,
      messages: 0,
      shippingAccounts: 0,
      shipments: 0,
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contact_merges_merged_idx').on(t.mergedContactId),
    index('contact_merges_survivor_idx').on(t.survivorContactId, t.createdAt),
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

    /**
     * The locale this channel reported, in the channel's own vocabulary —
     * `ar_AR`, `en_US`, `fr_FR` from Messenger.
     *
     * The *only* place a reported locale is stored — nothing copies it into
     * `contacts.locale`. That column answers "which language do we address this
     * person in", and everything reading it treats 'ar' as a settled
     * preference: `preferredLocale` returns 'ar' without looking at what the
     * customer wrote, and the CSAT job and the customer portal branch on it the
     * same way. A Facebook *interface* language is not that, and letting one
     * through would switch a merchant's email auto-replies to Arabic on the
     * strength of a setting they made on a different site. See
     * `DEFAULT_CONTACT_LOCALE` in `lib/contacts/locale.ts` for what that column
     * does mean.
     *
     * Kept verbatim, per channel, which is also the only thing that can answer
     * a contact whose two channels disagree.
     *
     * Only Messenger sets it. Instagram's profile API has no locale field and
     * WhatsApp's webhook carries no locale at all.
     */
    profileLocale: text('profile_locale'),

    /**
     * When a channel's profile API last answered for this identity — successfully
     * or with "this person has no name to give".
     *
     * Only Facebook and Instagram set it. WhatsApp carries the profile name in
     * the webhook itself and email has no profile to ask for, so neither has
     * anything to look up. It exists because "we have no name" and "we have not
     * asked" are different states and only the second is worth a Graph call: a
     * customer who has locked their profile down would otherwise be re-fetched
     * on every message they ever send.
     */
    profileFetchedAt: timestamp('profile_fetched_at', { withTimezone: true }),

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
