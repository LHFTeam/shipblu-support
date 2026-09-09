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

  const oldWebhooks = await db.delete(webhookEvents).where(webhookRetentionFilter());

  const oldJobs = await db.delete(jobs).where(completedJobRetentionFilter());

  console.log(
    `[cleanup] sessions=${expiredSessions} customer_sessions=${expiredCustomerSessions} ` +
      `contact_tokens=${expiredContactTokens} presence=${stalePresence.count} ` +
      `webhooks=${oldWebhooks.count} jobs=${oldJobs.count}`,
  );
}
