import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channelEnum, jobStatusEnum } from './enums';

/**
 * Every inbound webhook lands here before anything else happens, then the worker
 * processes it. Three things fall out of that:
 *
 *  - the HTTP handler returns 200 in single-digit ms, so Meta never times out
 *    and retries a delivery we already have;
 *  - a failed processing run can be replayed from the stored payload;
 *  - `providerEventId` gives idempotency when a provider redelivers.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'whatsapp' | 'postmark' | 'mailgun' | ... */
    provider: text('provider').notNull(),
    channel: channelEnum('channel'),

    /** Provider's own event id, when it supplies one. */
    providerEventId: text('provider_event_id'),

    payload: jsonb('payload').$type<unknown>().notNull(),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),

    signatureVerified: boolean('signature_verified').notNull().default(false),

    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('webhook_events_provider_event_idx').on(t.provider, t.providerEventId),
    // The worker's claim query: unprocessed, oldest first.
    index('webhook_events_unprocessed_idx').on(t.processedAt, t.receivedAt),
  ],
);

/**
 * Postgres-backed job queue, consumed with FOR UPDATE SKIP LOCKED.
 *
 * Chosen over Redis because at this volume it buys nothing but an extra service
 * to operate, and a table is far easier to inspect when a send goes wrong.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** e.g. send_email, send_whatsapp, download_media, process_webhook */
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),

    status: jobStatusEnum('status').notNull().default('pending'),

    /** Lower runs first; used to keep customer-visible sends ahead of imports. */
    priority: integer('priority').notNull().default(100),

    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),

    lastError: text('last_error'),

    /**
     * Set by the caller to make enqueueing idempotent — re-enqueuing the same
     * logical work (e.g. "send message X") collapses onto one row.
     */
    dedupeKey: text('dedupe_key'),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),

    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The claim query scans exactly this: pending work that is due, best first.
    index('jobs_claim_idx').on(t.status, t.runAt, t.priority),
    uniqueIndex('jobs_dedupe_idx').on(t.dedupeKey),
    index('jobs_type_idx').on(t.type, t.status),
  ],
);

/**
 * WhatsApp message templates, synced from Meta by a cron job. Sending outside the
 * 24-hour customer service window is only possible with an approved template, so
 * the console reads this table to decide what an agent is allowed to send.
 */
export const whatsappTemplates = pgTable(
  'whatsapp_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    metaTemplateId: text('meta_template_id').notNull(),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category').notNull(),

    /** Meta's component array: HEADER / BODY / FOOTER / BUTTONS. */
    components: jsonb('components').$type<unknown[]>().notNull().default([]),

    /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED */
    status: text('status').notNull(),

    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_templates_name_lang_idx').on(t.name, t.language),
    index('whatsapp_templates_status_idx').on(t.status),
  ],
);
