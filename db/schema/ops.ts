import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { agents } from './agents';
import { whatsappAccounts } from './config';
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

    /**
     * Which of a provider's connections delivered this — `facebook_page` or
     * `instagram_login` for Meta, null for a provider that has only one.
     *
     * Recorded because nothing downstream can work it out. Both Meta
     * connections deliver the same `instagram` payload, byte-identical apart
     * from the signature, and the only thing that separates them is which app
     * secret verified it — a fact known once, here, at the endpoint. It is also
     * part of `provider_event_id`, so a delivery from each connection is stored
     * rather than the second being deduplicated away: a per-connection count is
     * the answer to "is the direct connection actually delivering?", which has
     * been unanswerable through two outages.
     */
    connection: text('connection'),

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

    // The unprocessed backlog, oldest first — and partial, because that is the
    // only set anything asks for.
    //
    // It used to be a full index on `(processed_at, received_at)` described as
    // "the worker's claim query", which was wrong twice: the worker claims from
    // `jobs`, and a leading `processed_at` that is non-null on ~98% of rows
    // indexes the answer nobody wants. It cost 13 MB and was maintained on all
    // 206,053 inserts to serve **155 scans in 47 days**. As a partial index it
    // is kilobytes, and only an unprocessed row touches it at all.
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
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
 *
 * A template belongs to one WABA — the same name can exist on two business
 * accounts with different text, and be approved on one and rejected on the
 * other. So `whatsappAccountId` is part of the identity of a row, not a label
 * on it: without it a second account's sync would overwrite the first
 * account's copy, and the console would offer an agent a template that the
 * number they are replying from has never had approved.
 */
export const whatsappTemplates = pgTable(
  'whatsapp_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The account this template was synced from. Nullable only for rows written
     * before there were accounts; the sync adopts those on its next run by
     * upserting over them. `cascade` because a template is a cache of what the
     * WABA holds — disconnecting the WABA leaves nothing to send them from.
     */
    whatsappAccountId: uuid('whatsapp_account_id').references(() => whatsappAccounts.id, {
      onDelete: 'cascade',
    }),

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
    // A constraint rather than a unique index, for `nullsNotDistinct`: the
    // account is nullable, and postgres would otherwise treat every legacy row
    // as unique — the sync's conflict target would match nothing and each
    // hourly run would insert a fresh duplicate of every template until an
    // account adopted them.
    unique('whatsapp_templates_account_name_lang_idx')
      .on(t.whatsappAccountId, t.name, t.language)
      .nullsNotDistinct(),
    index('whatsapp_templates_status_idx').on(t.status),
  ],
);

/**
 * What a purge destroyed.
 *
 * The one record a hard delete leaves behind, and the reason it is worth having
 * is the question that gets asked afterwards: not "what was in ticket #482" —
 * that is gone and is meant to be — but "#482 was here yesterday, where did it
 * go, and who decided that?". `contact_merges` earns its row for the same
 * reason a merge does, and a purge is strictly heavier than a merge.
 *
 * **Deliberately not a foreign key to anything.** Every other audit trail in
 * this schema points at rows that still exist; this one points at rows that by
 * definition do not, so `subject_id` is a bare uuid and `summary` carries the
 * human-readable identity the id can no longer be resolved to. A
 * `references()` here would either refuse the delete or cascade the evidence
 * away with it. It also makes this row a copy of personal data that outlives
 * the purge by design — one of the reasons `RETAINED` gives for this not being
 * an erasure tool.
 *
 * `deleted_by_agent_id` is the exception and is `set null`: the purge still
 * happened after the person who did it has left, and `deleted_by_label` still
 * names them.
 */
export const adminDeletions = pgTable(
  'admin_deletions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** 'conversation' | 'contact' — plain text, see the note above on enums. */
    subject: text('subject').notNull(),
    subjectId: uuid('subject_id').notNull(),

    /**
     * What was destroyed, in one line an admin can read without joining
     * anything. A ticket is named by number, channel and subject —
     * `Ticket #482 (whatsapp) — Where is my parcel?` — and never by its
     * requester; a contact by name and address or number —
     * `Ali Hassan (ali@example.com · +20…)`. Who did it is in the two columns
     * below, not here.
     */
    summary: text('summary').notNull(),

    /** Row counts per table, plus the ticket numbers a contact purge took. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),

    deletedByAgentId: uuid('deleted_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    /** Kept beside the id so a departed agent is still named. */
    deletedByLabel: text('deleted_by_label'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The only way this table is ever read: newest first.
    index('admin_deletions_created_idx').on(t.createdAt),
    index('admin_deletions_subject_idx').on(t.subject, t.subjectId),
  ],
);
