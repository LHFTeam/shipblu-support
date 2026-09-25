import { lt, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationPresence, jobs, webhookEvents } from '@/db/schema';
import { deleteExpiredCustomerSessions } from '@/lib/auth/customer-session';
import { deleteExpiredSessions } from '@/lib/auth/session';
import { deleteExpiredContactTokens } from '@/lib/portal/accounts';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Housekeeping, run nightly by a Render cron job.
 *
 * Retention is deliberate rather than incidental: presence rows and webhook
 * payloads are the two tables that grow without bound and have no long-term
 * value, and raw webhook payloads contain customer PII we have no reason to keep
 * once the message they produced has been stored.
 */

/** Processed payloads: long enough to replay a delivery and debug what it did. */
const PROCESSED_WEBHOOK_DAYS = 30;

/**
 * Unverified payloads: kept only as the evidence they were stored to be.
 *
 * Much shorter than a processed one, and for the opposite reason. A processed
 * payload is kept because it is useful; an unverified one is kept because a
 * signature failure needs something to look at — and a week is long enough for
 * anybody to notice a channel has gone quiet and go looking.
 */
const UNVERIFIED_WEBHOOK_DAYS = 7;

/**
 * Which `webhook_events` rows the nightly pass may delete.
 *
 * Three clauses, and the first two clocks are the point. The predicate used to
 * be `processed_at is not null and processed_at < …` alone, which meant a
 * payload that **failed signature verification never got a `processed_at`, so
 * it never matched, so it was never deleted** — exempt from retention forever.
 * On 2026-09-09 that was 4,648 rows, the oldest from 19 August: the Instagram
 * §6.26/§6.29 signature failures, still on disk three weeks later.
 *
 * The exemption ran exactly the wrong way round. The docblock above says these
 * payloads are dropped because they carry customer PII, and an unverified one is
 * the case where we have *less* reason to keep it — there is no message to show
 * for it and nothing downstream ever read it.
 *
 * **The short clock keys on the signature, not on the missing timestamp**, and
 * that distinction is load-bearing rather than pedantic. `process-webhook.ts`
 * writes `processed_at` on success, on a deliberate drop and on a duplicate,
 * and on failure writes only `error` — so "no `processed_at`" also describes a
 * verified delivery whose processing failed for good, and whose job reached
 * `dead`. `completedJobRetentionFilter()` below keeps a dead job forever on the
 * stated grounds that it needs a human, and its payload is the only thing that
 * can be replayed: a seven-day clock on the absence of a timestamp would have
 * deleted the evidence a week after the failure and left the job pointing at a
 * row that no longer exists. Today the two predicates select the same 4,531
 * rows — production holds no verified-but-unprocessed row at all — so this is
 * written before the case arrives rather than after it.
 *
 * The third clause exists so that nothing is exempt forever, which was the
 * original bug: a verified row whose processing never completed is kept for the
 * full thirty days, the same lifetime as a processed one.
 *
 * Exported so `cleanup.test.ts` can read the SQL back. The `database` CI job
 * runs this handler but asserts nothing about it — it proves the statement
 * *plans*, not that the predicate selects what was meant.
 */
export function webhookRetentionFilter(): SQL {
  const processedHorizon = sql.raw(`interval '${PROCESSED_WEBHOOK_DAYS} days'`);

  return sql`(
    (${webhookEvents.processedAt} is not null
      and ${webhookEvents.processedAt} < now() - ${processedHorizon})
    or (${webhookEvents.signatureVerified} = false
      and ${webhookEvents.receivedAt} < now() - ${sql.raw(`interval '${UNVERIFIED_WEBHOOK_DAYS} days'`)})
    or (${webhookEvents.processedAt} is null
      and ${webhookEvents.signatureVerified}
      and ${webhookEvents.receivedAt} < now() - ${processedHorizon})
  )`;
}

/** Completed jobs only. A dead job is the record of a failure that needs a human. */
export function completedJobRetentionFilter(): SQL {
  return sql`${jobs.status} = 'completed' and ${jobs.completedAt} < now() - interval '7 days'`;
}

/**
 * How many rows one retention statement may remove.
 *
 * Small enough that a batch finishes well inside `DB_QUERY_TIMEOUT_MS` on the
 * largest table here, and large enough that a normal night is a handful of
 * round trips rather than hundreds.
 */
const RETENTION_BATCH = 5_000;

/**
 * The most batches one table gets in one run — a bound on the job, not on the
 * backlog.
 *
 * It exists so a table that is growing faster than retention can drain it ends
 * the night with a log line saying so, rather than with a cron that runs until
 * Render kills it. At the batch size above this is five million rows, which is
 * an order of magnitude past anything this system has produced.
 */
const MAX_RETENTION_BATCHES = 1_000;

/** The two tables retention batches over. Both are keyed by a uuid `id`. */
type RetentionTable = typeof webhookEvents | typeof jobs;

/**
 * One batch's statement, exported so `cleanup.test.ts` can read it back.
 *
 * `in (select … limit n)` rather than `ctid`: the subquery stops as soon as it
 * has found `n` matching rows — the case that matters here, where matches are
 * plentiful — and a primary key reads as what it is to the next person.
 *
 * The `limit` is interpolated as a bound parameter rather than pasted in, so
 * the batch size cannot become a way to write SQL. It is a module constant
 * today; that is not a reason to let it be spliced.
 */
export function retentionBatch(table: RetentionTable, where: SQL): SQL {
  return sql`delete from ${table} where ${table.id} in (
    select ${table.id} from ${table} where ${where} limit ${RETENTION_BATCH}
  )`;
}

/**
 * Delete everything matching `where`, a bounded number of rows at a time.
 *
 * **One unbounded `delete` is what broke this job.** `#153` gave every query a
 * 30-second deadline and `#155` widened webhook retention, and both landed in
 * the same release — on the night they shipped, the `webhook_events` delete
 * already took 25.5 s. It crossed 30 s four days later, and from then on the
 * statement was cancelled (`57014`) before it removed anything. That is a
 * ratchet rather than a flat failure: every night it fails, the rows it should
 * have removed are still there to slow the next attempt, so the table and the
 * runtime climb together. It failed on 2026-09-23 and again on 2026-09-25 while
 * the table went from 402,172 rows to 440,587.
 *
 * Raising the deadline only moves where the ratchet bites. Batching removes it:
 * the work per statement is fixed, so the time per statement is roughly fixed
 * however far behind the table has fallen, and a bad night costs more round
 * trips rather than a cancelled statement and no progress at all.
 *
 * The loop stops on a short batch, which is the only reliable signal that the
 * predicate has nothing left: a count taken first would be one more full scan
 * of the table this exists to stop scanning.
 */
async function deleteInBatches(table: RetentionTable, where: SQL, label: string): Promise<number> {
  let deleted = 0;

  for (let batch = 0; batch < MAX_RETENTION_BATCHES; batch += 1) {
    const result = await db.execute(retentionBatch(table, where));

    deleted += result.count;
    if (result.count < RETENTION_BATCH) return deleted;
  }

  // Reached only by a table gaining rows faster than this drains them. Worth a
  // line of its own: the count below would otherwise look like a healthy night.
  console.warn(
    `[cleanup] ${label} hit the ${MAX_RETENTION_BATCHES}-batch ceiling at ${deleted} rows — ` +
      `the backlog is outgrowing retention`,
  );

  return deleted;
}

export async function cleanup(_job: ClaimedJob): Promise<void> {
  const expiredSessions = await deleteExpiredSessions();
  const expiredCustomerSessions = await deleteExpiredCustomerSessions();
  // Spent and expired verification/reset links. They are useless once expired
  // and they are credentials-adjacent, so there is no reason to keep them.
  const expiredContactTokens = await deleteExpiredContactTokens();

  // Presence is ephemeral; anything older than an hour is a dead browser tab.
  //
  // The three deletes below read `.count` rather than ending `.returning()`.
  // They only ever used `.length`, so the ids were fetched to be counted and
  // thrown away: the jobs delete alone dragged 201,135 of them back at 1,816 ms
  // a run. postgres.js puts the row count on the result of a plain delete.
  const stalePresence = await db
    .delete(conversationPresence)
    .where(lt(conversationPresence.updatedAt, new Date(Date.now() - 60 * 60 * 1000)));

  // Batched, unlike the four above: these are the two tables that grow without
  // bound, so they are the two where one statement can outgrow the deadline.
  const oldWebhooks = await deleteInBatches(webhookEvents, webhookRetentionFilter(), 'webhooks');

  const oldJobs = await deleteInBatches(jobs, completedJobRetentionFilter(), 'jobs');

  console.log(
    `[cleanup] sessions=${expiredSessions} customer_sessions=${expiredCustomerSessions} ` +
      `contact_tokens=${expiredContactTokens} presence=${stalePresence.count} ` +
      `webhooks=${oldWebhooks} jobs=${oldJobs}`,
  );
}
