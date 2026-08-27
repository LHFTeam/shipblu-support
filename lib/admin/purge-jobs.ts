import { and, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { db } from '@/db/client';
import { jobs, messages, sideConversationMessages, sideConversations } from '@/db/schema';
import type { JobType } from '@/lib/queue';

/**
 * Cancel queued work owned by this purge, before the cascade removes its owner.
 *
 * A payload key is not a foreign key: `send_side_email.messageId` names a side
 * message, while the customer senders name `messages`. A global orphan sweep
 * checked only the latter and silently cancelled unrelated hub emails whenever
 * anybody deleted a ticket. Match both the job type and the subject's scope;
 * unrelated orphans and unfamiliar jobs belong to their own lifecycle.
 *
 * Run inside the purge transaction, while the message rows still exist. SQL
 * subqueries keep a large contact purge from materialising every message id.
 * Processing jobs belong to the worker already holding them, and completed or
 * dead jobs are history, so only pending and failed work is removed.
 */
export async function purgeJobs(
  tx: typeof db,
  conversationIds: string[],
  contactIds: string[] = [],
): Promise<void> {
  const scopes: SQL[] = [];

  if (conversationIds.length > 0) {
    const messageJobTypes = [
      'send_email',
      'send_whatsapp',
      'send_meta',
      'moderate_meta_comment',
      'download_media',
    ] satisfies JobType[];

    scopes.push(
      and(
        inArray(jobs.type, messageJobTypes),
        exists(
          tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                inArray(messages.conversationId, conversationIds),
                eq(sql`${messages.id}::text`, sql`${jobs.payload}->>'messageId'`),
              ),
            ),
        ),
      )!,
      and(
        eq(jobs.type, 'send_side_email' satisfies JobType),
        exists(
          tx
            .select({ id: sideConversationMessages.id })
            .from(sideConversationMessages)
            .innerJoin(
              sideConversations,
              eq(sideConversations.id, sideConversationMessages.sideConversationId),
            )
            .where(
              and(
                inArray(sideConversations.conversationId, conversationIds),
                eq(sql`${sideConversationMessages.id}::text`, sql`${jobs.payload}->>'messageId'`),
              ),
            ),
        ),
      )!,
      and(
        eq(jobs.type, 'send_csat' satisfies JobType),
        inArray(sql`${jobs.payload}->>'conversationId'`, conversationIds),
      )!,
    );
  }

  if (contactIds.length > 0) {
    scopes.push(
      and(
        eq(jobs.type, 'fetch_meta_profile' satisfies JobType),
        inArray(sql`${jobs.payload}->>'contactId'`, contactIds),
      )!,
    );
  }

  if (scopes.length === 0) return;
  await tx.delete(jobs).where(and(inArray(jobs.status, ['pending', 'failed']), or(...scopes)));
}
