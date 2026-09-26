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
 *
 * Only `pending` work is removed. `failJob()` puts a job that will retry back to
 * `pending` and one that will not to `dead`; nothing in `lib/queue` ever writes
 * the enum's `failed`, so matching it only made the filter look wider than it
 * is. Completed and dead jobs are history. A `processing` job belongs to the
 * worker already holding it — deleting its row would not stop the handler, and
 * would only let `completeJob()` update nothing — so those are left to fail on
 * their own: every handler scoped here re-reads its subject by id and ends for
 * good when it is gone (`worker/handlers/subject-gone.ts`; `send_csat` and
 * `fetch_meta_profile` return quietly), and `download_media` re-checks under a
 * lock before it keeps an object it stored.
 *
 * Two kinds of pending work name this purge's subject and are deliberately not
 * matched, because nothing in their payload can tie them to it safely:
 *
 * - `send_notification_email` carries a finished email — `to`, subject and
 *   bodies — and no contact or conversation id. Matching on the address would
 *   be matching on a value another contact may share or later be given. What
 *   it sends is a portal link, and the portal tokens behind it cascade with the
 *   contact, so the link it delivers is already dead.
 * - `process_webhook` carries only a `webhook_events` id, and who the delivery
 *   is about is inside the provider's raw payload, in a different shape per
 *   channel. Parsing it here would re-implement three ingest parsers inside a
 *   delete, and a wrong guess would silently drop a real customer's message.
 *   A delivery still pending for this contact will, when it runs, file a new
 *   contact and ticket for them — which is the same thing a message arriving
 *   one minute after the purge would do. `RETAINED` says so.
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
  await tx.delete(jobs).where(and(eq(jobs.status, 'pending'), or(...scopes)));
}
