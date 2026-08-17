import { lt, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationPresence, jobs, webhookEvents } from '@/db/schema';
import { deleteExpiredSessions } from '@/lib/auth/session';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Housekeeping, run nightly by a Render cron job.
 *
 * Retention is deliberate rather than incidental: presence rows and processed
 * webhook payloads are the two tables that grow without bound and have no
 * long-term value, and raw webhook payloads contain customer PII we have no
 * reason to keep once the message they produced has been stored.
 */
export async function cleanup(_job: ClaimedJob): Promise<void> {
  const expiredSessions = await deleteExpiredSessions();

  // Presence is ephemeral; anything older than an hour is a dead browser tab.
  const stalePresence = await db
    .delete(conversationPresence)
    .where(lt(conversationPresence.updatedAt, new Date(Date.now() - 60 * 60 * 1000)))
    .returning({ agentId: conversationPresence.agentId });

  // Processed webhook payloads: keep 30 days for replay and debugging.
  const oldWebhooks = await db
    .delete(webhookEvents)
    .where(
      sql`${webhookEvents.processedAt} is not null and ${webhookEvents.processedAt} < now() - interval '30 days'`,
    )
    .returning({ id: webhookEvents.id });

  // Completed jobs: keep 7 days. Dead jobs are never auto-deleted — they are
  // the record of something that actually failed and needs a human.
  const oldJobs = await db
    .delete(jobs)
    .where(sql`${jobs.status} = 'completed' and ${jobs.completedAt} < now() - interval '7 days'`)
    .returning({ id: jobs.id });

  console.log(
    `[cleanup] sessions=${expiredSessions} presence=${stalePresence.length} ` +
      `webhooks=${oldWebhooks.length} jobs=${oldJobs.length}`,
  );
}
