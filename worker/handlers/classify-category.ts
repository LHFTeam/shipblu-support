import { classifyMessageCategory } from '@/lib/category-ai/run';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';
import { subjectGone } from './subject-gone';

const log = logger('classify_category');

/**
 * Asks Jev which team's work one inbound message is, and acts on a confident
 * answer.
 *
 * Enqueued by `afterMessageStored` for the first few customer messages on a
 * ticket nobody has answered yet, while the switch on `/admin/categories` is
 * `shadow` or `apply`. The decision and every rule behind it are in
 * `lib/category-ai/`; this is the queue's side of it.
 *
 * A transient provider failure, or a settings read that failed, throws and is
 * retried by the queue. A switch turned off, or a key not set, is a skip and not
 * a failure: a job queued before an admin turned the classifier off should
 * finish quietly, not fill the dead queue.
 */
export async function classifyCategory(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'classify_category');
  const result = await classifyMessageCategory(messageId);

  switch (result.status) {
    case 'gone':
      throw subjectGone('classify_category', `message ${messageId}`);
    case 'skipped':
      log.info('skipped', { messageId, reason: result.reason });
      return;
    case 'already_classified':
      return;
    case 'recorded':
      log.info('recorded', {
        messageId,
        outcome: result.outcome,
        predicted: result.predicted ?? 'none',
      });
      return;
  }
}
