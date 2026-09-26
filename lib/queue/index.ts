import { and, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';

export type JobType =
  | 'process_webhook'
  | 'send_email'
  | 'send_side_email'
  | 'send_notification_email'
  | 'send_agent_invite'
  | 'send_whatsapp'
  | 'send_meta'
  | 'moderate_meta_comment'
  | 'download_media'
  | 'fetch_meta_profile'
  | 'sync_whatsapp_templates'
  | 'sync_shipment'
  | 'sync_stale_shipments'
  | 'subscribe_meta_webhooks'
  | 'check_meta_permissions'
  | 'test_comment_permission'
  | 'sla_sweep'
  | 'assign_sweep'
  | 'presence_sweep'
  | 'run_time_automations'
  | 'send_csat'
  | 'rollup_metrics'
  | 'snapshot_backlog'
  | 'import_freshdesk_kb'
  | 'backfill_shipment_links'
  | 'backfill_message_locations'
  | 'backfill_meta_profiles'
  | 'backfill_categorise_ai'
  | 'normalise_kb_formatting'
  | 'seed_console_handbook'
  | 'cleanup';

export type EnqueueOptions = {
  /** Lower runs first. Customer-visible sends should beat bulk imports. */
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /**
   * Makes enqueueing idempotent. Re-enqueuing the same key while a job is still
   * pending collapses onto the existing row instead of sending twice — which is
   * what stops a webhook retry from producing a duplicate outbound message.
   *
   * **A key is spent for good, not until the job finishes.** `jobs_dedupe_idx`
   * is a plain unique index over the whole table, not a partial one over pending
   * rows, so the conflict target still matches a job that completed weeks ago —
   * and a job that reached `dead` is never deleted by `cleanup` at all, which
   * makes its key unusable for the life of the database. `enqueue` then returns
   * null and the caller sees "already queued".
   *
   * So use it only where the work is genuinely once-ever for that key — one
   * outbound send, one media download. Anything that might legitimately need to
   * run again for the same subject must not be keyed on the subject; make the
   * handler idempotent instead and enqueue without a key.
   */
  dedupeKey?: string;
};

export type ClaimedJob = typeof jobs.$inferSelect;

export async function enqueue(
  type: JobType,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<string | null> {
  const values = {
    type,
    payload,
    priority: options.priority ?? 100,
    runAt: options.runAt ?? new Date(),
    maxAttempts: options.maxAttempts ?? 5,
    dedupeKey: options.dedupeKey ?? null,
  };

  if (values.dedupeKey) {
    const rows = await db
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({ target: jobs.dedupeKey })
      .returning({ id: jobs.id });
    return rows[0]?.id ?? null;
  }

  const rows = await db.insert(jobs).values(values).returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

/**
 * Enqueues many jobs of one type in a single insert.
 *
 * For a backfill, which enqueues one job per row it found. The loop-and-await
 * version is one database round trip per job — invisible at twenty, minutes of
 * pure latency at twenty thousand, which is the size a backfill is for.
 *
 * No `dedupeKey`, deliberately: the index behind it is a plain unique index over
 * the whole table, so a key can only ever be used once in the life of the
 * system. A bulk enqueue is exactly where that bites — see the note on
 * `dedupeKey` above — so the handlers this is used with have to be idempotent
 * themselves.
 */
export async function enqueueMany(
  type: JobType,
  payloads: Record<string, unknown>[],
  options: Omit<EnqueueOptions, 'dedupeKey'> = {},
): Promise<number> {
  if (payloads.length === 0) return 0;

  const rows = await db
    .insert(jobs)
    .values(
      payloads.map((payload) => ({
        type,
        payload,
        priority: options.priority ?? 100,
        runAt: options.runAt ?? new Date(),
        maxAttempts: options.maxAttempts ?? 5,
        dedupeKey: null,
      })),
    )
    .returning({ id: jobs.id });

  return rows.length;
}

/**
 * Claim up to `limit` due jobs.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run from several worker
 * processes at once: each transaction takes rows nobody else holds, so workers
 * never collide and a slow job never blocks the queue behind it.
 */
export async function claimJobs(limit: number, workerId: string): Promise<ClaimedJob[]> {
  const rows = await db.execute<ClaimedJob>(sql`
    WITH claimed AS (
      SELECT id FROM ${jobs}
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY priority ASC, run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${jobs} j
    SET status = 'processing',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = j.attempts + 1
    FROM claimed
    WHERE j.id = claimed.id
    RETURNING j.*;
  `);

  return (rows as unknown as JobRow[]).map(toClaimedJob);
}

type JobRow = Record<string, unknown>;

/**
 * Raw SQL bypasses drizzle's column mapping, so `RETURNING j.*` hands back the
 * database's own names — `max_attempts`, not `maxAttempts`. Casting the result
 * to the schema's row type only hid that: `failJob` read `job.maxAttempts` off
 * such a row, got `undefined`, and `attempts >= undefined` is false on every
 * attempt — so no job ever reached 'dead'. A failing send retried hourly
 * forever instead of stopping at five, and for a customer-visible reply that
 * means it can still go out days after the agent wrote it.
 *
 * Written out field by field rather than case-converted in a loop, because then
 * a column added to the table stops this compiling instead of arriving as
 * another silent `undefined`.
 */
export function toClaimedJob(row: JobRow): ClaimedJob {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status as ClaimedJob['status'],
    priority: row.priority as number,
    runAt: row.run_at as Date,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error ?? null) as string | null,
    dedupeKey: (row.dedupe_key ?? null) as string | null,
    lockedAt: (row.locked_at ?? null) as Date | null,
    lockedBy: (row.locked_by ?? null) as string | null,
    completedAt: (row.completed_at ?? null) as Date | null,
    createdAt: row.created_at as Date,
  };
}

export async function completeJob(id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'completed', completedAt: new Date(), lockedAt: null, lockedBy: null })
    .where(eq(jobs.id, id));
}

/**
 * A failure no retry can fix, so the job is marked dead at once instead of
 * spending its remaining attempts.
 *
 * For input that is wrong — a payload that fails its handler's schema — and not
 * for a provider that said no. A provider's refusal is either transient, which
 * is what retries are for, or permanent in a way a handler records on the row a
 * person reads (`send_whatsapp` marks the message failed and returns), which is
 * where an agent will see it. Nor for a job type with no handler: with
 * `autoDeploy` off, the web service can enqueue a type before the worker that
 * runs it is deployed, and a retry is exactly what rescues that job.
 */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

/**
 * Exponential backoff with a 1-hour ceiling: 10s, 40s, 90s, ... A job that has
 * used all its attempts becomes 'dead' rather than being deleted, so failures
 * stay visible and can be inspected and replayed. A `PermanentJobError` goes
 * there on its first attempt.
 */
export async function failJob(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  const exhausted = error instanceof PermanentJobError || job.attempts >= job.maxAttempts;

  if (exhausted) {
    await db
      .update(jobs)
      .set({ status: 'dead', lastError: message, lockedAt: null, lockedBy: null })
      .where(eq(jobs.id, job.id));
    return;
  }

  const backoffSeconds = Math.min(10 * job.attempts ** 2, 3600);

  await db
    .update(jobs)
    .set({
      status: 'pending',
      lastError: message,
      runAt: new Date(Date.now() + backoffSeconds * 1000),
      lockedAt: null,
      lockedBy: null,
    })
    .where(eq(jobs.id, job.id));
}

/**
 * Return jobs whose worker died mid-run to the queue. A process killed by a
 * deploy leaves rows stuck in 'processing' with no one holding the lock; without
 * this they would never run again.
 */
/**
 * How long a job may hold its lock before the queue assumes its worker died and
 * runs it again. Anything a job waits on — an outbound request above all — has
 * to give up well inside this, or a job that is merely slow is run twice.
 */
export const STALLED_AFTER_MS = 5 * 60 * 1000;

export async function reclaimStalledJobs(olderThanMs = STALLED_AFTER_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);

  const reclaimed = await db
    .update(jobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, 'processing'), lte(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });

  return reclaimed.length;
}

export async function queueDepth(): Promise<{ pending: number; processing: number; dead: number }> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(or(eq(jobs.status, 'pending'), eq(jobs.status, 'processing'), eq(jobs.status, 'dead')))
    .groupBy(jobs.status);

  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  return {
    pending: byStatus.pending ?? 0,
    processing: byStatus.processing ?? 0,
    dead: byStatus.dead ?? 0,
  };
}
