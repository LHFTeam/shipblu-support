import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents, groups } from './agents';
import { conversations } from './conversations';
import { channelEnum } from './enums';

export const csatSurveys = pgTable(
  'csat_surveys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** SHA-256 of the token embedded in the survey link. */
    tokenHash: text('token_hash').notNull(),

    /** 1–5. Null until the customer responds. */
    rating: integer('rating'),
    comment: text('comment'),

    /** Snapshotted at send time so later reassignment doesn't rewrite history. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('csat_surveys_token_idx').on(t.tokenHash),
    index('csat_surveys_conversation_idx').on(t.conversationId),
    index('csat_surveys_responded_idx').on(t.respondedAt),
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
