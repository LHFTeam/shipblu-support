import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents, groups } from './agents';
import { conversations, messages } from './conversations';
import {
  channelEnum,
  csatAnswerSourceEnum,
  csatDeliveryEnum,
  csatStatusEnum,
  rootCauseOwnerEnum,
} from './enums';

/**
 * One row per time the system decided whether to ask a customer how it went.
 *
 * A `sent` row is the survey; a `skipped` row says why there was none, which
 * is the only place that question has an answer and what lets a report say
 * how many resolutions were surveyed. The decision is `send_csat`'s, read by
 * the ticket sidebar, the admin page's recent list and the rollup.
 */
export const csatSurveys = pgTable(
  'csat_surveys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    status: csatStatusEnum('status').notNull().default('sent'),
    /** Why there was no survey; null unless `skipped`. A `SkipReason` (`lib/csat/skip-reasons.ts`). */
    skipReason: text('skip_reason'),

    /**
     * SHA-256 of the token embedded in the survey link. Null on a skipped row,
     * which never had a link; a survey answered in a chat card or a Messenger
     * sheet will need none either.
     */
    tokenHash: text('token_hash'),

    /** 1–5. Null until the customer responds. */
    rating: integer('rating'),
    comment: text('comment'),

    /**
     * Snapshotted at send time so later reassignment doesn't rewrite history.
     * The channel too: a ticket merged elsewhere keeps the channel it was
     * surveyed on. Null only on the one row written before the column existed.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    channel: channelEnum('channel'),

    /** How it reached the customer; null when it did not. */
    delivery: csatDeliveryEnum('delivery'),
    /** `ar` or `en`, what it went out in. */
    locale: text('locale'),
    /** The outbound row that carried it, so the timeline and the sidebar agree on what was sent. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    /**
     * The wording it went out with, so the landing page asks the question the
     * mail asked. Null for the built-in wording, and again once the rule is
     * deleted — the page then falls back to the built-in, which is what the
     * rule was a variation of.
     */
    ruleId: uuid('rule_id').references((): AnyPgColumn => csatRules.id, { onDelete: 'set null' }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /**
     * Which door the answer came through (`csat_answer_source`). Null until
     * there is an answer, and on one recorded before the column existed — all
     * of which came through the page, and none of which production holds.
     */
    answerSource: csatAnswerSourceEnum('answer_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('csat_surveys_token_idx').on(t.tokenHash),
    index('csat_surveys_conversation_idx').on(t.conversationId),
    index('csat_surveys_responded_idx').on(t.respondedAt),
    index('csat_surveys_created_idx').on(t.createdAt),
    // The job enqueues without a dedupe key and is idempotent instead, so two
    // runs racing on one ticket meet here rather than sending two surveys.
    uniqueIndex('csat_surveys_open_idx')
      .on(t.conversationId)
      .where(sql`${t.status} = 'sent'`),
  ],
);

/**
 * The survey switch and its numbers: one row, `id = 1`, read through a
 * thirty-second memo (`lib/csat/settings.ts`). No row is a fresh install and
 * reads as off, with every channel off — the plan's "nothing goes out until
 * an admin says which channels". Not `presence_policy`'s shape only because
 * there is more than a pair of windows here.
 */
export const csatSettings = pgTable('csat_settings', {
  id: integer('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(false),

  /** Resolve → send. The grace in which a customer's "one more thing" reopens the ticket instead. */
  delayMinutes: integer('delay_minutes').notNull().default(30),
  /**
   * The same for Facebook and Instagram only, or null for `delayMinutes`. A
   * Meta survey only sends inside the messaging window, which the default
   * half hour can outlive; the report's skip reasons are what says so.
   */
  metaDelayMinutes: integer('meta_delay_minutes'),
  /** Don't survey the same ticket twice inside this many days. */
  resurveyAfterDays: integer('resurvey_after_days').notNull().default(14),

  // One switch per deliverable channel. `portal` rides email's; WhatsApp has
  // none, for the reason `plans/csat.md` gives.
  surveyEmail: boolean('survey_email').notNull().default(false),
  surveyWebchat: boolean('survey_webchat').notNull().default(false),
  surveyFacebook: boolean('survey_facebook').notNull().default(false),
  surveyInstagram: boolean('survey_instagram').notNull().default(false),
  surveyApi: boolean('survey_api').notNull().default(false),

  /** Whether a ticket an automation rule resolved is surveyed as one an agent resolved is. */
  surveyRuleResolved: boolean('survey_rule_resolved').notNull().default(true),

  /**
   * Messenger's feedback card requires a link to the business's privacy
   * policy (`business_privacy.url`) and Graph refuses the card without one,
   * so a Facebook ticket is not surveyed while this is null — the ticket says
   * so, rather than carrying a card that failed.
   */
  privacyUrl: text('privacy_url'),
  /** How long Messenger keeps the card answerable: Meta's `expires_in_days`, 1–7. */
  metaExpiresInDays: integer('meta_expires_in_days').notNull().default(3),
  /**
   * What Graph said the last time it refused the feedback card, and when.
   * Meta marks the card "in development", so the day it is withdrawn is a
   * refusal on a worker's job; written here, it is a sentence on the admin
   * page instead (§6.27), and those surveys go as quick replies meanwhile.
   */
  lastTemplateRefusal: text('last_template_refusal'),
  lastTemplateRefusalAt: timestamp('last_template_refusal_at', { withTimezone: true }),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAgentId: uuid('updated_by_agent_id').references(() => agents.id, {
    onDelete: 'set null',
  }),
});

/**
 * What a survey says, scoped like the out-of-hours reply: two nullable columns
 * rather than a `scope` enum, the most specific row wins, and the scope is
 * the identity (`plans/out-of-hours-auto-response.md`). No row matching is the
 * built-in wording in `lib/csat/wording.ts`, so the switch works before an
 * admin has written a word.
 *
 * Every customer-facing string is an `_ar` / `_en` pair, both `not null
 * default ''`, either covering the other. The lengths are Meta's — the same
 * strings become a Messenger card's title, subtitle, button and question in a
 * later stage — and they are enforced on every row, not only one scoped to
 * Facebook, because a group rule with no channel reaches Facebook too.
 */
export const csatRules = pgTable(
  'csat_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Null means every group, including tickets that have none. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    /** Null means every channel. */
    channel: channelEnum('channel'),

    /** The question itself: the email's heading, the card's question, Messenger's question title. */
    questionAr: text('question_ar').notNull().default(''),
    questionEn: text('question_en').notNull().default(''),
    /** The first line: the email's opening, Messenger's card title. */
    introAr: text('intro_ar').notNull().default(''),
    introEn: text('intro_en').notNull().default(''),
    /** The second line: Messenger's card subtitle. */
    subtitleAr: text('subtitle_ar').notNull().default(''),
    subtitleEn: text('subtitle_en').notNull().default(''),
    /** The confirm button on the page and the card, Messenger's button title. */
    buttonAr: text('button_ar').notNull().default(''),
    buttonEn: text('button_en').notNull().default(''),
    /** The comment box's label; the follow-up's placeholder on Messenger. */
    commentPromptAr: text('comment_prompt_ar').notNull().default(''),
    commentPromptEn: text('comment_prompt_en').notNull().default(''),
    /** After an answer. */
    thanksAr: text('thanks_ar').notNull().default(''),
    thanksEn: text('thanks_en').notNull().default(''),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `nulls not distinct`, as `auto_responses_scope_key`: two rows for one
    // scope would make the winner depend on row order.
    unique('csat_rules_scope_key').on(t.groupId, t.channel).nullsNotDistinct(),
  ],
);

/**
 * Nightly rollups. Dashboards read only from here, so reporting never runs live
 * aggregates across the full message history — which is what makes the reports
 * page stay fast as the ticket archive grows.
 */
export const metricsDaily = pgTable(
  'metrics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),

    /** Null in each dimension means "all" — the table stores rolled-up totals too. */
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    channel: channelEnum('channel'),

    ticketsCreated: integer('tickets_created').notNull().default(0),
    ticketsResolved: integer('tickets_resolved').notNull().default(0),
    ticketsReopened: integer('tickets_reopened').notNull().default(0),

    /** Seconds, business-hours aware. */
    firstResponseSecondsSum: integer('first_response_seconds_sum').notNull().default(0),
    firstResponseCount: integer('first_response_count').notNull().default(0),
    resolutionSecondsSum: integer('resolution_seconds_sum').notNull().default(0),
    resolutionCount: integer('resolution_count').notNull().default(0),

    slaFirstResponseMet: integer('sla_first_response_met').notNull().default(0),
    slaFirstResponseBreached: integer('sla_first_response_breached').notNull().default(0),
    slaResolutionMet: integer('sla_resolution_met').notNull().default(0),
    slaResolutionBreached: integer('sla_resolution_breached').notNull().default(0),

    csatRatingSum: integer('csat_rating_sum').notNull().default(0),
    csatResponseCount: integer('csat_response_count').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('metrics_daily_dimensions_idx').on(t.day, t.groupId, t.agentId, t.channel),
    index('metrics_daily_day_idx').on(t.day),
  ],
);

/**
 * Measured handling time: how long an agent actually had a ticket in front of
 * them.
 *
 * Beaten by the ticket page, and only while the tab is visible, the window has
 * focus and the agent has touched something recently. All three conditions
 * matter and each removes a specific lie: a background tab is not work, a window
 * behind the shipping platform is not work, and a ticket left open over lunch is
 * very much not work. An agent with three tickets open beats from one of them,
 * so concurrency cannot inflate the total past the time that actually elapsed —
 * which is what makes occupancy (`focus / online`) a ratio rather than a number
 * that can exceed 100%.
 *
 * Intervals rather than a row per beat: a beat every 30 seconds per agent would
 * be tens of thousands of rows a day for a figure nobody reads at that
 * resolution. Extending `last_beat_at` is one UPDATE, and switching tickets
 * closes this row and opens the next.
 *
 * This is *attention on the page*, not total effort. Research done in another
 * system, or a phone call about the ticket, is invisible here — so this reads
 * lower than a contact-centre AHT that includes after-contact work, and the
 * report says so rather than letting the two be compared silently.
 */
export const agentFocusIntervals = pgTable(
  'agent_focus_intervals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastBeatAt: timestamp('last_beat_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_focus_intervals_agent_idx').on(t.agentId, t.startedAt),
    index('agent_focus_intervals_conversation_idx').on(t.conversationId),
    index('agent_focus_intervals_open_idx')
      .on(t.agentId, t.lastBeatAt)
      .where(sql`${t.endedAt} is null`),
  ],
);

/**
 * What each agent was holding, sampled hourly.
 *
 * Backlog at the end of a day is the one metric here that cannot be recomputed
 * later. `conversations` carries only the current status and the current
 * assignee, so asking it tomorrow what somebody was holding last Tuesday gives
 * today's answer wearing last Tuesday's date. Replaying `status_changed` events
 * instead would be both expensive and quietly wrong — imported tickets have no
 * event history at all.
 *
 * Sampling hourly rather than once at midnight also sidesteps the Cairo DST
 * problem: Render's cron schedules are UTC, so a fixed "end of day" cron drifts
 * by an hour twice a year, and the rollup would silently take its snapshot from
 * the wrong side of the boundary. With hourly rows the rollup picks the sample
 * nearest the day's end *in the reporting zone* and is right either way.
 *
 * Never rewritten. The nightly rollup reads these; it must not own them, or its
 * delete-and-rebuild would destroy the only copy of a measurement that cannot be
 * taken again.
 */
export const agentBacklogSnapshots = pgTable(
  'agent_backlog_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),

    openCount: integer('open_count').notNull().default(0),
    pendingCount: integer('pending_count').notNull().default(0),
    /** Of those, the ones where the customer spoke last and is still waiting. */
    awaitingReplyCount: integer('awaiting_reply_count').notNull().default(0),
    breachedCount: integer('breached_count').notNull().default(0),
  },
  (t) => [index('agent_backlog_snapshots_agent_idx').on(t.agentId, t.at)],
);

/**
 * One row per agent per day: the half of productivity that is about the person
 * rather than about the ticket.
 *
 * Deliberately its own table rather than more columns on `metrics_daily`. That
 * table's contract is four slices with null meaning "all", and `reconciles()`
 * asserts the totals row equals the sum of the channel slices. A login time has
 * no channel, so it would either break that assertion or force three of every
 * four rows to carry meaningless zeros — and the assertion is the only thing
 * standing between a double-counting bug and a report that merely looks busy.
 *
 * It holds only what `metrics_daily` does not. Resolved counts, response times,
 * SLA attainment and CSAT are already computed per agent there, by the same
 * nightly pass, and the report joins them rather than storing them twice: two
 * copies of "resolved today" is two numbers that will eventually disagree.
 */
export const agentMetricsDaily = pgTable(
  'agent_metrics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    // --- Shift: when they were here ---------------------------------------
    firstOnlineAt: timestamp('first_online_at', { withTimezone: true }),
    lastOnlineAt: timestamp('last_online_at', { withTimezone: true }),
    /**
     * What their calendar said, so punctuality is a comparison rather than an
     * opinion. Null on a closed day or a holiday — which is why lateness is
     * null there too, instead of a large positive number for not working a day
     * nobody asked them to work.
     */
    scheduledStartAt: timestamp('scheduled_start_at', { withTimezone: true }),
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),

    // --- Availability: how long, and how much of it was usable ------------
    onlineSeconds: integer('online_seconds').notNull().default(0),
    /** Online *and* accepting work. This is "available time". */
    acceptingSeconds: integer('accepting_seconds').notNull().default(0),
    /** Online time that fell inside their calendar — the adherence numerator. */
    onlineWithinHoursSeconds: integer('online_within_hours_seconds').notNull().default(0),
    scheduledSeconds: integer('scheduled_seconds').notNull().default(0),
    /** Separate connected stretches. Many short ones is a connectivity story. */
    sessionCount: integer('session_count').notNull().default(0),
    longestSessionSeconds: integer('longest_session_seconds').notNull().default(0),

    // --- Volume ------------------------------------------------------------
    assignedCount: integer('assigned_count').notNull().default(0),
    /** Distinct conversations they did anything to — wider than "assigned". */
    touchedCount: integer('touched_count').notNull().default(0),
    publicReplies: integer('public_replies').notNull().default(0),
    privateNotes: integer('private_notes').notNull().default(0),
    /** Handed on to somebody else, or unassigned, by anyone. */
    transferredAwayCount: integer('transferred_away_count').notNull().default(0),
    /**
     * Taken back off them by the sweep because they had gone quiet. Its own
     * column because it is the punctuality failure with a customer attached:
     * work that sat with somebody who was not there.
     */
    reclaimedFromCount: integer('reclaimed_from_count').notNull().default(0),

    // --- Backlog, from the nearest snapshot to the day's end --------------
    openAtDayEnd: integer('open_at_day_end'),
    pendingAtDayEnd: integer('pending_at_day_end'),

    // --- Handling ----------------------------------------------------------
    focusSeconds: integer('focus_seconds').notNull().default(0),
    /** The denominator for average handling time. */
    conversationsFocused: integer('conversations_focused').notNull().default(0),

    // --- Quality -----------------------------------------------------------
    /**
     * Resolutions this agent actually performed — they moved the ticket into a
     * resolved status themselves.
     *
     * Deliberately not `metrics_daily.tickets_resolved`, which counts tickets
     * resolved *while assigned to* somebody. That is the right question for the
     * queue and the wrong denominator for a reopen rate: a rate whose numerator
     * counts one population and whose denominator counts another can exceed
     * 100% without anything being broken, and then means nothing at all.
     */
    resolutionsMade: integer('resolutions_made').notNull().default(0),

    /**
     * Of those resolutions, how many the customer came back on.
     *
     * The counterweight that makes the speed columns safe to look at. Handling
     * time and resolution time are both trivially gamed by closing tickets that
     * are not finished, and the market guidance is consistent that a speed
     * metric shown without one of these produces exactly that behaviour.
     */
    reopenedAfterResolveCount: integer('reopened_after_resolve_count').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Both dimensions are NOT NULL here, unlike `metrics_daily`, so a plain
    // unique index really is unique and the rollup can upsert onto it.
    uniqueIndex('agent_metrics_daily_dimensions_idx').on(t.day, t.agentId),
    index('agent_metrics_daily_day_idx').on(t.day),
  ],
);

/**
 * What tickets were about, per day.
 *
 * Its own table rather than a dimension on `metrics_daily`, and the reason is
 * not size — it is that `reconciles()` would have to be deleted. That assertion
 * checks a day's totals row equals the sum of its channel slices, and its own
 * comment calls it "the only thing standing between a double-counting bug and a
 * report that merely looks busy". Categories are **multi-valued**: a ticket
 * routinely carries two or three, so category slices can never sum to the total.
 * Adding one to a table whose contract is single-valued slices either breaks
 * that assertion or forces it to be relaxed, and relaxing it is worse than not
 * having the dimension.
 *
 * Keyed on the **text key**, not the category's id, so a retired or merged
 * category still reports. A report drawn last quarter must stay readable after
 * somebody tidies the taxonomy.
 *
 * `channel` is NOT NULL with no "all" slice — the opposite choice from
 * `metrics_daily`, deliberately. There is no totals row to reconcile against, so
 * nulls buy nothing, and NOT NULL makes the unique index actually unique, which
 * sidesteps the NULL-distinctness trap that forces the delete-and-insert rebuild
 * next door. The page sums whichever channels it is showing.
 *
 * **Everything here is recomputable**, which is what makes a delete-and-insert
 * rebuild safe: `conversations.created_at` and `resolved_at` are immutable, and
 * `conversation_categories.first_seen_at` is append-only. The column that must
 * never be added is "suggestions still open at day end" — that is current state,
 * and a rebuild would write today's answer onto an old date. It would only
 * surface on the third night, when the recompute window reaches back, which is
 * the hardest possible failure to notice. Ask that question live instead, the
 * way the review queue does.
 */
export const categoryMetricsDaily = pgTable(
  'category_metrics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),

    /** The key as assigned, so a retired category still reports. */
    categoryKey: text('category_key').notNull(),
    area: text('area').notNull(),
    channel: channelEnum('channel').notNull(),

    /** Conversations created this day that carry this category as primary. */
    ticketsPrimary: integer('tickets_primary').notNull().default(0),
    /**
     * …and carrying it at all.
     *
     * Deliberately does not sum to the day's ticket count, because a ticket with
     * three categories appears under three of them. Anything rendering this has
     * to say so, or the first person to add the column up files a bug.
     */
    ticketsAny: integer('tickets_any').notNull().default(0),

    /** How the assignment was made, counted from immutable `first_seen_at`. */
    assignedAuto: integer('assigned_auto').notNull().default(0),
    assignedSuggested: integer('assigned_suggested').notNull().default(0),
    assignedManual: integer('assigned_manual').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('category_metrics_daily_dimensions_idx').on(t.day, t.categoryKey, t.channel),
    index('category_metrics_daily_day_idx').on(t.day),
    index('category_metrics_daily_area_idx').on(t.area, t.day),
  ],
);

/**
 * Why tickets happened, per day, and who owns fixing it.
 *
 * The report the whole feature exists for. A category report says what the queue
 * was full of; only this says what to go and change — and because the owner is
 * carried here rather than joined at read time, "how much did the courier
 * network cost us last month" is one grouped read.
 *
 * `owner` is denormalised out of `ticket_root_causes` on purpose, and it is the
 * one denormalisation here: resolving it through the registry at read time would
 * re-attribute history the moment somebody corrects a cause's owner, and a
 * report that silently rewrites last quarter is worse than one that is a little
 * out of date.
 *
 * Counted from `conversations.resolved_at` rather than `created_at`: the cause
 * is recorded at resolution, so a ticket that arrives in one month and is
 * understood in the next belongs to the month somebody worked it out.
 */
export const rootCauseMetricsDaily = pgTable(
  'root_cause_metrics_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    day: date('day').notNull(),

    causeKey: text('cause_key').notNull(),
    /** Frozen with the row — see the docstring. */
    owner: rootCauseOwnerEnum('owner').notNull(),
    channel: channelEnum('channel').notNull(),

    ticketsResolved: integer('tickets_resolved').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('root_cause_metrics_daily_dimensions_idx').on(t.day, t.causeKey, t.channel),
    index('root_cause_metrics_daily_day_idx').on(t.day),
    index('root_cause_metrics_daily_owner_idx').on(t.owner, t.day),
  ],
);
