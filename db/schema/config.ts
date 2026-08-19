import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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

    /** Default group and status applied to tickets arriving on this channel. */
    defaultGroupId: uuid('default_group_id').references(() => groups.id, { onDelete: 'set null' }),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('channels_type_idx').on(t.type, t.isActive)],
);
