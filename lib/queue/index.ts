import { and, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';

export type JobType =
  | 'process_webhook'
  | 'send_email'
  | 'send_side_email'
  | 'send_notification_email'
  | 'send_whatsapp'
  | 'send_meta'
  | 'download_media'
  | 'sync_whatsapp_templates'
  | 'subscribe_meta_webhooks'
  | 'sla_sweep'
  | 'assign_sweep'
  | 'run_time_automations'
  | 'send_csat'
  | 'rollup_metrics'
  | 'snapshot_backlog'
  | 'import_freshdesk_kb'
  | 'backfill_shipment_links'
  | 'backfill_message_locations'
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
 * Exponential backoff with a 1-hour ceiling: 10s, 40s, 90s, ... A job that has
 * used all its attempts becomes 'dead' rather than being deleted, so failures
 * stay visible and can be inspected and replayed.
 */
export async function failJob(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

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
export async function reclaimStalledJobs(olderThanMs = 5 * 60 * 1000): Promise<number> {
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
