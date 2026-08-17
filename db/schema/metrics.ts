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
