import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents, groups } from './agents';
import {
  automationTriggerEnum,
  cannedVisibilityEnum,
  channelEnum,
  slaHoursSourceEnum,
  statusCategoryEnum,
  ticketFieldTypeEnum,
} from './enums';

/** One day's opening hours; multiple ranges allow a lunch break. */
export type TimeRange = { start: string; end: string };
export type WeeklySchedule = {
  mon: TimeRange[];
  tue: TimeRange[];
  wed: TimeRange[];
  thu: TimeRange[];
  fri: TimeRange[];
  sat: TimeRange[];
  sun: TimeRange[];
};

/**
 * One calendar: a timezone, the operating days and hours in it, and — via
 * `holidays` — the days it is shut regardless.
 *
 * There is a global default (`isDefault`), and a group may point at a different
 * one. Both SLA arithmetic and reporting resolve a ticket's calendar the same
 * way, in `lib/hours/resolve.ts`, so a due date and the report measuring it
 * never disagree about which days counted.
 */
export const businessHours = pgTable(
  'business_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** IANA zone. ShipBlu's default is Africa/Cairo. */
    timezone: text('timezone').notNull().default('Africa/Cairo'),
    schedule: jsonb('schedule').$type<WeeklySchedule>().notNull(),
    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('business_hours_name_idx').on(t.name)],
);

/**
 * Days a calendar is shut. Attached to a schedule rather than global, which is
 * what lets a group keep its own holiday list: a group pointing at its own
 * schedule gets that schedule's holidays and none of the default one's.
 */
export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessHoursId: uuid('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('holidays_bh_date_idx').on(t.businessHoursId, t.date)],
);

/**
 * Statuses are configurable rather than hard-coded so the team can keep the
 * exact set they use in Freshdesk. `category` is what SLA and reporting key off,
 * and `stopsSlaClock` is what makes "Pending — waiting on customer" not count
 * against resolution time.
 */
export const ticketStatuses = pgTable(
  'ticket_statuses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    category: statusCategoryEnum('category').notNull(),
    stopsSlaClock: boolean('stops_sla_clock').notNull().default(false),
    /** Shown to customers in the portal; internal-only statuses are hidden. */
    visibleToCustomer: boolean('visible_to_customer').notNull().default(true),
    customerLabel: text('customer_label'),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [
    uniqueIndex('ticket_statuses_name_idx').on(t.name),
    index('ticket_statuses_position_idx').on(t.position),
  ],
);

export const ticketFields = pgTable(
  'ticket_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable key used inside `conversations.custom_fields`. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: ticketFieldTypeEnum('type').notNull(),

    /** For dropdown/multi_select. */
    options: jsonb('options').$type<{ value: string; label: string }[]>().notNull().default([]),

    requiredOnCreate: boolean('required_on_create').notNull().default(false),
    requiredOnResolve: boolean('required_on_resolve').notNull().default(false),
    visibleToCustomer: boolean('visible_to_customer').notNull().default(false),
    editableByCustomer: boolean('editable_by_customer').notNull().default(false),

    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ticket_fields_key_idx').on(t.key)],
);

export type SlaTarget = {
  firstResponseMins: number | null;
  nextResponseMins: number | null;
  resolutionMins: number | null;
};
export type SlaTargets = Record<'low' | 'medium' | 'high' | 'urgent', SlaTarget>;

/** Escalate to these agents N minutes after the corresponding target is missed. */
export type SlaEscalation = { afterMins: number; agentIds: string[] };

export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),

    /** Same condition DSL as automation rules; first match by position wins. */
    conditions: jsonb('conditions').$type<unknown>().notNull().default({}),
    targets: jsonb('targets').$type<SlaTargets>().notNull(),

    /**
     * Which calendar the targets are counted against.
     *
     * `group` — the default — is what makes a team's own operating days and
     * holidays apply to its tickets: the group's schedule wins, and the global
     * default schedule covers every group that has not set one. `schedule`
     * pins the policy to `businessHoursId` regardless of group, and
     * `round_the_clock` counts wall-clock time.
     */
    hoursSource: slaHoursSourceEnum('hours_source').notNull().default('group'),

    /** The schedule used when `hoursSource` is `schedule`. */
    businessHoursId: uuid('business_hours_id').references(() => businessHours.id, {
      onDelete: 'set null',
    }),

    escalations: jsonb('escalations')
      .$type<{ firstResponse?: SlaEscalation; resolution?: SlaEscalation }>()
      .notNull()
      .default({}),

    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sla_policies_position_idx').on(t.position)],
);

/**
 * Covers all three Freshdesk automation types in one table:
 *   on_create  → Dispatch'r
 *   on_update  → Observer
 *   time_based → Supervisor (swept by a cron job)
 */
export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    trigger: automationTriggerEnum('trigger').notNull(),

    conditions: jsonb('conditions').$type<unknown>().notNull().default({}),
    actions: jsonb('actions').$type<unknown[]>().notNull().default([]),

    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    /** Later rules are skipped for this ticket once a matching rule sets this. */
    stopProcessing: boolean('stop_processing').notNull().default(false),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automation_rules_trigger_idx').on(t.trigger, t.isActive, t.position)],
);

export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    folder: text('folder'),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),

    visibility: cannedVisibilityEnum('visibility').notNull().default('global'),
    /** Set when visibility = 'personal'. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    /** Set when visibility = 'group'. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),

    usageCount: integer('usage_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('canned_responses_visibility_idx').on(t.visibility),
    index('canned_responses_agent_idx').on(t.agentId),
  ],
);

/**
 * One WhatsApp Business Account, and the credential that talks to it.
 *
 * A WABA is the unit Meta scopes almost everything to: the phone numbers it
 * owns, the message templates approved on it, and the media ids its numbers
 * hand us. Before this table there was one of each, named by
 * `WHATSAPP_WABA_ID` in the environment, and a second business account meant a
 * second deploy of the whole app.
 *
 * The row holds ids, never a token. `tokenEnvVar` *names* the environment
 * variable the access token is read from — a level of indirection that keeps
 * the rule the rest of the configuration follows (a database dump contains no
 * usable credential) while still letting one WABA use a different credential
 * from another. Null means the shared `META_PAGE_ACCESS_TOKEN`, which is the
 * right answer whenever the accounts sit under one Meta app, and that is the
 * ordinary case: a Business Manager with several WABAs installs one app on all
 * of them and one system-user token serves the lot.
 *
 * What is deliberately *not* per-account is the app secret and the verify
 * token. Those belong to the Meta app, not to the business account, and
 * `X-Hub-Signature-256` is verified with a single secret in
 * `app/api/webhooks/whatsapp`. Connecting a WABA that lives under a *different*
 * Meta app therefore needs more than a row here — see the note in
 * `lib/whatsapp/accounts.ts`.
 */
export const whatsappAccounts = pgTable(
  'whatsapp_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Admin-facing label: "ShipBlu Egypt", not the id. */
    name: text('name').notNull(),
    /** Meta's WhatsApp Business Account id, from the WhatsApp Manager. */
    wabaId: text('waba_id').notNull(),

    /**
     * Name of the environment variable holding this account's access token.
     * Null uses `META_PAGE_ACCESS_TOKEN`. Constrained to a prefix in
     * `lib/whatsapp/accounts.ts` — an admin naming an arbitrary variable would
     * otherwise be choosing which of the process's secrets gets sent to Meta as
     * a bearer token.
     */
    tokenEnvVar: text('token_env_var'),

    /**
     * The account used when nothing else names one: a template send on a
     * conversation with no inbound history, or a media download from before
     * this table existed.
     */
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),

    /**
     * Outcome of the last template sync. Kept on the row because a WABA that
     * has been connected but whose token cannot read it looks identical to a
     * working one on every screen — the failure is otherwise only in the cron
     * log, which nobody reads until a template send fails.
     */
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two rows for the same WABA would sync templates twice into the same
    // (account, name, language) slot and make "which token does this number
    // use?" ambiguous.
    uniqueIndex('whatsapp_accounts_waba_idx').on(t.wabaId),
    uniqueIndex('whatsapp_accounts_name_idx').on(t.name),
  ],
);

/**
 * A configured inbox: one support mailbox, or one WhatsApp number.
 *
 * `config` holds non-secret settings only (addresses, display names, defaults).
 * Credentials stay in environment variables and are referenced by name, so a
 * database dump never contains a usable access token.
 */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: channelEnum('type').notNull(),
    name: text('name').notNull(),

    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * Which WhatsApp Business Account this number belongs to, for `whatsapp`
     * and `whatsapp_bot` rows and null for every other type.
     *
     * A column rather than another key in `config` because it is a foreign key:
     * a WABA that is deleted must not leave numbers pointing at an id that is
     * gone, and `set null` degrades to the pre-multi-WABA behaviour — the
     * default account — rather than to a send that throws.
     */
    whatsappAccountId: uuid('whatsapp_account_id').references(() => whatsappAccounts.id, {
      onDelete: 'set null',
    }),

    /** Default group and status applied to tickets arriving on this channel. */
    defaultGroupId: uuid('default_group_id').references(() => groups.id, { onDelete: 'set null' }),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('channels_type_idx').on(t.type, t.isActive),
    // Unique, like the other configuration tables. Two channels sharing a name
    // is indistinguishable in every list that shows them, and it is the natural
    // conflict target that lets the seed be re-run without making a second copy
    // of the bot channel.
    uniqueIndex('channels_name_idx').on(t.name),
    index('channels_whatsapp_account_idx').on(t.whatsappAccountId),
  ],
);

/**
 * The message a customer gets when they write in and nobody is working.
 *
 * Scope is two nullable columns rather than a `scope` enum, and that is what
 * makes "by group or by channel" one table instead of two. A row matches a
 * ticket when every column it *does* set matches, so `{group: null, channel:
 * 'whatsapp'}` is "every group, on WhatsApp", `{group: Returns, channel: null}`
 * is "the Returns team, everywhere", and both dimensions set is the pair. The
 * most specific matching row wins, resolved in `lib/auto-response/resolve.ts`.
 *
 * `channel` is the channel *type* rather than a `channels` row: the wording that
 * differs is the medium's — an email can carry three paragraphs where a WhatsApp
 * message should be two lines — and the type is the discriminator every other
 * read, filter and report already keys on. A second mailbox needing its own
 * wording is a real case, and it is deliberately not this one.
 *
 * Bodies are plain text. An out-of-hours acknowledgement is three sentences, a
 * rich text editor would buy formatting nobody needs, and storing HTML would
 * mean sanitising admin-authored markup on the way in and again around every
 * substituted value. The email HTML is built from the text at send time, after
 * substitution, so escaping the values is not a step anybody can forget.
 *
 * Which hours count as "out" is **not** configured here. It is the ticket's
 * group calendar, resolved through `lib/hours/resolve.ts` like every SLA due
 * date — a second schedule attached to the message is a second answer to "are
 * we open?", and the two would disagree the first time somebody edited one.
 */
export const autoResponses = pgTable(
  'auto_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Null means every group, including tickets that have none. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    /** Null means every channel. */
    channel: channelEnum('channel'),

    /**
     * Sent outside the group's working hours. One per language: the requester's
     * `contacts.locale` picks, and whichever is filled in covers the other, so a
     * team that only writes Arabic is not forced to write English too.
     */
    bodyAr: text('body_ar').notNull().default(''),
    bodyEn: text('body_en').notNull().default(''),

    /**
     * The holiday override, sent instead on a day the calendar marks a holiday.
     * Empty falls back to the ordinary out-of-hours body, which is what makes
     * the override optional rather than something every row has to fill in
     * twice.
     *
     * One body covers every holiday because `{{holiday}}` interpolates the name
     * off the calendar. Per-holiday wording would mean re-typing a message for
     * each of a dozen public holidays, in two languages, every year.
     */
    holidayBodyAr: text('holiday_body_ar').notNull().default(''),
    holidayBodyEn: text('holiday_body_en').notNull().default(''),

    /**
     * Match this scope and send nothing.
     *
     * The only way to say "not here" once a broader row exists: the widget
     * already tells a web chat visitor the office is shut before they type, so a
     * company-wide row plus a silent `webchat` row is a real configuration, and
     * without this it could only be expressed by deleting the company row and
     * restating it on every other channel — where the next channel anybody adds
     * would silently get nothing.
     */
    silent: boolean('silent').notNull().default(false),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `nulls not distinct`, so two "every group, on WhatsApp" rows collide
    // rather than making the winner depend on row order — the scope *is* the
    // identity here, which is why these rows carry no name of their own.
    unique('auto_responses_scope_key').on(t.groupId, t.channel).nullsNotDistinct(),
    index('auto_responses_active_idx').on(t.isActive),
  ],
);

/**
 * The Arabic wording the public tracking page shows for a delivery status or a
 * courier's reason code.
 *
 * **Overrides only.** Every phrase already has a default compiled into
 * `lib/shipments/status.ts`, and a row here exists only where somebody decided
 * ours was not ShipBlu's. That is what makes this table safe to be empty — which
 * it is on the day it ships — and what makes adding a new phrase in code a
 * deploy rather than a data migration. Clearing the box in the admin screen
 * deletes the row rather than storing an empty string, so "reset to default" is
 * a real action and not a second kind of blank.
 *
 * Keyed by the phrase's stable `key` rather than by the platform's status token:
 * several tokens read as one phrase — `picked_up`, `pickup_complete` and
 * `collected` are all `picked_up` — and keying on the token would ask an admin to
 * type the same Arabic three times and keep the three in step forever.
 *
 * `ar` and no `en` column, deliberately. English readers see the platform's own
 * word, which is the property `/en/track` exists to have; a column that let an
 * admin restate ShipBlu's English in our own words would quietly undo it.
 */
export const shipmentPhrases = pgTable('shipment_phrases', {
  key: text('key').primaryKey(),
  ar: text('ar').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => agents.id, { onDelete: 'set null' }),
});
