import { env } from '@/lib/env';
import { logger } from '@/lib/log';
import { enqueue, retryDelaySeconds, type EnqueueOptions } from '@/lib/queue';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';

/**
 * Queueing the webhook that tells myBlu's backend the team wrote on one of its
 * users' tickets (`plans/myblu-ticket-api.md`, _The webhook_). What the job
 * sends, and how, is `lib/api/webhook.ts`; this is the half the web service
 * runs, kept apart so the two doors every outbound reply passes can call it
 * without importing the sending half.
 */

const log = logger('notify_myblu');

/**
 * Whether the webhook is switched on: `MYBLU_WEBHOOK_URL` set, the
 * `instagramLoginConfigured()` device. Only the URL's presence, read on the web
 * service where the job is queued; whether it is a URL the worker may post to,
 * and whether a secret signs it, the worker decides when the job runs
 * (`webhookTarget`), so a value set wrongly fails every job, by name, where
 * somebody reading the queue looks, rather than queueing nothing in silence.
 */
export function mybluWebhookConfigured(): boolean {
  return Boolean(env().MYBLU_WEBHOOK_URL?.trim());
}

/**
 * How many times a delivery is attempted before the job goes `dead`.
 *
 * The receiver dedupes on the event's `id` for a day, because the worker runs
 * a job at least once: an attempt it answered but whose answer we lost is sent
 * again, and must meet the `id` it recorded. So the last attempt has to fall
 * within a day of the event, or a retry could meet an `id` the receiver has
 * forgotten and push twice. With the queue's backoff (`retryDelaySeconds`, ten
 * seconds times the square of the attempts so far, an hour at most), thirty
 * attempts spend their last about seventeen hours in. The queue's default of
 * five spends it five minutes in, which a receiver's own deploy can outlast,
 * and every push in that window would be lost. `notify.test.ts` adds the
 * schedule up from `retryDelaySeconds` itself, so a change to the backoff that
 * breaks the bound fails there.
 *
 * The job also refuses an event older than `MAX_EVENT_AGE_MS`
 * (`lib/api/webhook.ts`), which holds the bound when the queue itself is late:
 * a worker that was down for a day.
 */
export const NOTIFY_MAX_ATTEMPTS = 30;

/** Seconds from a job's first attempt to its last, at `NOTIFY_MAX_ATTEMPTS`, waiting nothing for the attempts themselves. */
export function lastAttemptAfterSeconds(maxAttempts = NOTIFY_MAX_ATTEMPTS): number {
  let total = 0;
  for (let attempts = 1; attempts < maxAttempts; attempts += 1) {
    total += retryDelaySeconds(attempts);
  }
  return total;
}

/** The job's key: once ever for a message, the argument `send:<messageId>` makes for a carrier. */
function dedupeKeyFor(messageId: string): string {
  return `notify_myblu:message:${messageId}`;
}

/**
 * Queues `message.created` for a message the team wrote, from the two doors
 * every outbound reply passes: `storeAgentReply`, a person's, and
 * `enqueueAutomatedDelivery`, software's. Nothing for a channel but the myBlu
 * app's, and nothing while the webhook is switched off.
 *
 * Ids only, in the job as in the body it becomes: a dead job's payload is kept
 * for good, and a message purged before a retry lands is never sent late.
 *
 * On the pool it is best-effort, and a failure is logged rather than thrown:
 * the reply is already stored, and on the app's channel stored is delivered —
 * the app's next poll reads it — so a push that cannot be queued must not
 * read to the agent as a reply that failed, and send it twice. On a
 * transaction (`on`), as the survey's door queues its carrier, it throws: a
 * failed statement has already aborted the transaction, and the caller's next
 * one would fail on it anyway, with the message rolled back beside it.
 */
export async function enqueueMessageCreated(
  channel: ConversationChannel,
  messageId: string,
  { priority, on }: Pick<EnqueueOptions, 'priority' | 'on'> = {},
): Promise<void> {
  if (channel !== 'api' || !mybluWebhookConfigured()) return;

  const queue = () =>
    enqueue(
      'notify_myblu',
      { event: 'message.created', messageId },
      {
        priority,
        on,
        dedupeKey: dedupeKeyFor(messageId),
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
      },
    );

  if (on) {
    await queue();
    return;
  }
  try {
    await queue();
  } catch (error) {
    log.error(`not queued: the reply is stored, with no push messageId=${messageId}`, error);
  }
}
