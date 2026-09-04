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
  categoryAudienceEnum,
  channelEnum,
  priorityEnum,
  rootCauseOwnerEnum,
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
 *
 * The name is stored per language because it is not an internal label: the
 * out-of-hours auto-response interpolates it into the message a customer reads,
 * through `{{holiday}}`, and that message is already chosen by their language.
 * One name meant an Arabic body carrying "Eid al-Fitr" in Latin script — the
 * message was translated and the one proper noun in it was not.
 *
 * Either side may be blank, like every other bilingual pair here, so a team
 * that only writes Arabic is not made to transliterate; `holidayName()` falls
 * back to whichever is filled in. The admin action requires at least one.
 */
export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessHoursId: uuid('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    nameAr: text('name_ar').notNull().default(''),
    nameEn: text('name_en').notNull().default(''),

    /**
     * Superseded by the pair above, and still here on purpose.
     *
     * Only the two web services run `db:migrate` (`preDeployCommand` in
     * `render.yaml`); the worker and the four crons deploy separately and by
     * hand. Dropping this column in the same release that stops writing it
     * would mean the still-running old worker selecting a column that no longer
     * exists — and `loadHoursCatalog` is on the SLA sweep, assignment, the
     * nightly rollup and the widget's open/closed check, so the whole of that
     * would fail until somebody redeployed it. Expand now, contract once every
     * service is on new code; `docs/PROJECT-STATE.md` §5.5 carries the removal.
     *
     * Defaulted rather than made nullable so an old reader gets the same empty
     * string an unwritten translation gives it, rather than a null it has never
     * had to handle.
     */
    name: text('name').notNull().default(''),
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

/**
 * One choice on a dropdown or multi-select.
 *
 * Two strings, not three. `label` is the wording the console shows and the one
 * an English reader gets; `labelAr` is the Arabic. There is deliberately no
 * `labelEn`, because it would be a second English label that `localised` reaches
 * only when `label` is blank — and `label` is never blank. Adding it would mean
 * a column an admin can fill in that changes nothing.
 */
export type TicketFieldOption = {
  value: string;
  label: string;
  labelAr?: string;
};

/**
 * What a ticket is about, and why it happened — the two registries.
 *
 * Deliberately two questions, because conflating them is what makes most support
 * taxonomies useless for improving anything:
 *
 * - A **category** is the customer's own account of their problem. "Where is my
 *   order." It is detected from what they wrote, on arrival, and one ticket can
 *   carry several.
 *
 * - A **root cause** is why that happened, recorded by the agent on resolve,
 *   because *the customer does not know it*. "Where is my order" has at least six
 *   causes behind it: the pickup never happened, the hub mis-sorted it, the
 *   merchant gave a wrong address, the courier never called, the zone is
 *   unserviced, or the parcel is on time and the expectation was wrong. Guessing
 *   between those from the complaint text would manufacture confident, wrong data
 *   in the exact place the team is trying to reason, so nothing tries.
 *
 * The consequence worth stating: a category report says what the queue is full
 * of, and only the cause report says what to go and fix.
 *
 * Both live here beside `ticket_statuses` and `ticket_fields` rather than in
 * their own file, because `conversations` points at them and everything else
 * points at `conversations` — the schema's import graph is acyclic today and a
 * registry in a leaf module is what would break it. The join table that carries
 * the assignments is in `db/schema/categories.ts`.
 */

/**
 * The category registry.
 *
 * A table rather than a constant because renaming "Cost and payment methods" to
 * "Pricing" is a decision by whoever owns the report and should not be a deploy.
 * What is *not* here is the matching rules: those live in `lib/categorise/`,
 * compiled, with tests. A regular expression typed into an admin form is a
 * production incident with no review — `(a+)+$` over every inbound message is a
 * denial of service, and a stray `.*` files the whole archive under one label.
 * `shipment_phrases` below draws the same line for the same reason.
 *
 * The join between the two halves is `key`, which is why it is the one column
 * here nobody may edit: every compiled rule names one, every stored assignment
 * freezes one, and every report groups by one.
 */
export const ticketCategories = pgTable(
  'ticket_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `area.slug`. Immutable once created — see the docstring. */
    key: text('key').notNull(),

    /**
     * The first level of the hierarchy, always the part of `key` before the dot,
     * held there by a CHECK in `db/sql`.
     *
     * Its own column so a report can group by area without `split_part` in every
     * query. Fifty-one flat categories is a list nobody reads; eleven areas is a
     * chart that fits on a screen, and the drill-down is the same table.
     */
    area: text('area').notNull(),

    /**
     * Both languages, because the customers write Arabic and the console is in
     * English.
     *
     * `labelAr` is not decoration. It is what a report shown to an Egyptian
     * operations lead is read in, and it is the string an agent matches against
     * the words actually in front of them. A taxonomy maintained only in English
     * makes everybody translate in their head at the moment they are choosing,
     * which is where mis-categorisation comes from.
     */
    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar').notNull(),

    description: text('description'),

    /** Which population raises this. Narrows the picker; see the enum. */
    audience: categoryAudienceEnum('audience').notNull().default('any'),

    /**
     * Nothing auto-assigns this; an agent files it by hand.
     *
     * The honest home for a category the business needs a bucket for and the
     * archive has no evidence of. A category no rule can ever award is not dead
     * weight if it is marked as such — it is dead weight if it sits in the same
     * list pretending to be detectable, because then a zero count reads as "this
     * never happens" rather than "nothing is looking for it".
     */
    isDetectable: boolean('is_detectable').notNull().default(true),

    /** Seeded from `lib/categorise/taxonomy.ts`. Deactivated, never deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),

    /** Order in the picker, and the last tie-break when two scores are equal. */
    position: integer('position').notNull().default(0),

    /**
     * Where a merged category's counts now go.
     *
     * Merging by rewriting the assignments would destroy the record of what was
     * actually chosen at the time; merging by deleting would orphan every report
     * older than the edit. A forwarding pointer keeps both — stored rows keep the
     * key they were given, and reporting resolves through this. One hop only: a
     * CHECK forbids pointing at yourself, and the resolver does not recurse.
     */
    supersededByKey: text('superseded_by_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_categories_key_idx').on(t.key),
    index('ticket_categories_area_idx').on(t.area, t.position),
    index('ticket_categories_active_idx').on(t.isActive, t.position),
  ],
);

/**
 * The root cause registry.
 *
 * One row per way a ticket can have come to exist, each naming exactly one
 * accountable party. The owner lives **here** rather than on the ticket so that
 * accountability is a join: an agent answers one question — why did this happen —
 * and who owns it follows. Asking them to set both invites the two to disagree,
 * and then neither report can be trusted.
 *
 * Read this alongside `lib/shipments/status.ts`, which holds the courier's own
 * status and reason vocabulary. They are not the same thing and must not be
 * merged: the platform's `attempted` says what the courier *recorded*, and
 * `courier.no_attempt` says we established it did not happen. The gap between
 * those two is the most valuable thing this table can measure.
 */
export const ticketRootCauses = pgTable(
  'ticket_root_causes',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** `owner.slug`, immutable, for the reasons `ticket_categories.key` is. */
    key: text('key').notNull(),

    labelEn: text('label_en').notNull(),
    labelAr: text('label_ar').notNull(),
    description: text('description'),

    owner: rootCauseOwnerEnum('owner').notNull(),

    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    position: integer('position').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_root_causes_key_idx').on(t.key),
    index('ticket_root_causes_owner_idx').on(t.owner, t.position),
  ],
);

/**
 * Extra constraints on what one field will accept, beyond its type.
 *
 * Attached to the field rather than to the form element that places it: a
 * tracking number has the same shape wherever it is asked for, and a per-form
 * override would be a second place to look when the wrong thing is rejected.
 *
 * `pattern` is a JavaScript regular expression source, anchored by the parser
 * rather than by the admin — an unanchored pattern that happens to match a
 * substring is the classic way a validation rule silently accepts everything.
 * The message is per-locale because it is the one validation string a customer
 * actually reads; blank falls back to a generic sentence in their language.
 */
export type TicketFieldValidation = {
  pattern?: string;
  patternMessageAr?: string;
  patternMessageEn?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
};

export const ticketFields = pgTable(
  'ticket_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable key used inside `conversations.custom_fields`. */
    key: text('key').notNull(),
    label: text('label').notNull(),

    /**
     * The customer-facing wording, one per language.
     *
     * `label` above is deliberately left alone: it is what the console sidebar,
     * the condition builder's vocabulary and every parser error message already
     * use, and every existing field has one. These two are additive, blank means
     * "use `label`", and the pair is the same shape `auto_responses` uses for
     * its bodies — a team that only writes Arabic is not forced to write English
     * too.
     *
     * Not the knowledge base's row-per-locale model, because a field is one
     * thing with one key and one stored answer that happens to be *asked* in two
     * languages. Two rows would mean two keys on a table whose whole point is
     * that the key is unique.
     */
    labelAr: text('label_ar'),
    labelEn: text('label_en'),

    type: ticketFieldTypeEnum('type').notNull(),

    /** For dropdown/multi_select. */
    options: jsonb('options').$type<TicketFieldOption[]>().notNull().default([]),

    /** Null means "whatever the type already enforces". */
    validation: jsonb('validation').$type<TicketFieldValidation | null>(),

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

/**
 * A named set of questions that opens a ticket.
 *
 * Every ticket this helpdesk could open before this table existed was opened by
 * somebody writing a sentence. The one form that existed — the portal's
 * new-ticket page — asked the same questions of everybody: a subject, a message,
 * and every custom field marked visible *and* editable, in one fixed order. A
 * damaged parcel and a refund request are not the same interview, and an admin
 * had no way to say so.
 *
 * **The layout is one jsonb document, not a `ticket_form_fields` join table.**
 * The join table is the obvious answer and it is the wrong one here for the
 * reason `automation_rules.actions` is also jsonb: the layout is edited,
 * validated and stored as a single document by one builder, so a join would
 * spread one save across N inserts, N updates and M deletes and would still need
 * a `position` column to put the rows back in order.
 *
 * What a join buys is a foreign key onto `ticket_fields`, and this codebase
 * already settled that question: `lib/rules/conditions.ts` says a rule naming a
 * deleted custom field "should quietly stop matching rather than break the
 * sweep". An element naming a field that no longer exists is dropped by
 * `parseFormElements` at read time, so deleting a field degrades a form instead
 * of breaking the page. What is owed in exchange is a warning on the way out,
 * which is why `deleteField` refuses while a form still names the key.
 *
 * The Arabic and English columns follow `auto_responses`: whichever is filled in
 * covers the other, so a team writing only Arabic is not forced to write English
 * too.
 */
export const ticketForms = pgTable(
  'ticket_forms',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The URL segment on the help centre. Built through `lib/kb/slug.ts`, never
     * an ASCII slugify — Arabic is the default locale and the front door, and
     * an ASCII slugify erases it entirely.
     */
    slug: text('slug').notNull(),

    nameAr: text('name_ar').notNull().default(''),
    nameEn: text('name_en').notNull().default(''),
    descriptionAr: text('description_ar').notNull().default(''),
    descriptionEn: text('description_en').notNull().default(''),

    /** `FormElement[]`, validated by `parseFormElements` at every read. */
    elements: jsonb('elements').$type<unknown[]>().notNull().default([]),

    /**
     * Whether a visitor has to be signed in to submit.
     *
     * Off is the interesting case: an anonymous form asks for a name and an
     * email and resolves onto a contact the same way an inbound email does. See
     * `lib/forms/submit.ts` for what that risks and what is done about it.
     */
    requiresSignIn: boolean('requires_sign_in').notNull().default(true),

    /**
     * Where the form is offered. Two flags rather than one enum because a form
     * can legitimately be both — most are — and an internal triage form that
     * only agents may open is a real case that a single "audience" column would
     * force into a third value nobody reads correctly.
     */
    showOnHelpCentre: boolean('show_on_help_centre').notNull().default(true),
    showInConsole: boolean('show_in_console').notNull().default(true),

    /**
     * What the form presets on the ticket it opens.
     *
     * These exist so "Report a damaged parcel" lands on the Ops queue at high
     * priority without an automation rule per form. They are defaults, not
     * overrides: an on-create automation still runs afterwards and still wins,
     * because the automation is the layer an admin uses to express a rule that
     * spans forms.
     *
     * Null priority means the column default (`medium`) rather than a second way
     * of writing it, so a form that does not care does not have an opinion.
     */
    defaultGroupId: uuid('default_group_id').references(() => groups.id, {
      onDelete: 'set null',
    }),
    defaultPriority: priorityEnum('default_priority'),
    defaultType: text('default_type'),
    defaultTags: text('default_tags').array().notNull().default([]),

    /**
     * The ticket's subject, built from the answers — `Damaged parcel —
     * {{tracking_number}}`. Empty falls back to the form's own name, because an
     * inbox of forty identically-titled tickets is worse than a long subject.
     */
    subjectTemplate: text('subject_template'),

    /** Shown after a successful submission; blank falls back to a generic thank-you. */
    confirmationAr: text('confirmation_ar').notNull().default(''),
    confirmationEn: text('confirmation_en').notNull().default(''),

    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ticket_forms_slug_idx').on(t.slug),
    index('ticket_forms_position_idx').on(t.position),
  ],
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

/**
 * A reply written once and sent many times, in both languages.
 *
 * ShipBlu's customers write in Arabic and in English on the same channel, often
 * in the same hour, so a single body meant the boilerplate was only reusable for
 * half the queue — the other half was retyped from memory every time, which is
 * where wording drifts.
 *
 * **One title, two bodies.** The title is the agent's label for the pair and the
 * console it is read in is English throughout; making it bilingual would ask
 * every response to be named twice so that a dropdown could show one of them.
 * The two bodies are the same response, not two responses.
 *
 * Either body may be blank — a team writes the Arabic first and the English when
 * they get to it — and the picker offers a response only in the languages it
 * actually has. `saveCannedResponse` requires at least one, because a response
 * with neither is a row nothing can ever send.
 */
export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    folder: text('folder'),

    /*
      Both forms of each body, for the reason the single pair was stored twice
      before this: email sends HTML and WhatsApp and the social channels send
      text, and deriving one from the other at send time would leave every
      channel guessing at line breaks.
    */
    bodyHtmlAr: text('body_html_ar').notNull().default(''),
    bodyTextAr: text('body_text_ar').notNull().default(''),
    bodyHtmlEn: text('body_html_en').notNull().default(''),
    bodyTextEn: text('body_text_en').notNull().default(''),

    /**
     * Superseded by the four columns above, and kept for one release for the
     * reason `holidays.name` is — the worker deploys separately from the
     * service that runs the migration, and the old `sendCannedReply` selects
     * these. Dropped once every service is on new code; see
     * `docs/PROJECT-STATE.md` §5.5.
     */
    bodyHtml: text('body_html').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),

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
