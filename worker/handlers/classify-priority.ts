import { classifyMessagePriority } from '@/lib/priority-ai/run';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';
import { subjectGone } from './subject-gone';

const log = logger('classify_priority');

/**
 * Asks Jev how urgent one inbound message is, and acts on a confident answer.
 *
 * Enqueued by `afterMessageStored` for every inbound customer message on a
 * channel the team works, while `PRIORITY_AI` is `shadow` or `apply`. The
 * decision and every rule behind it are in `lib/priority-ai/`; this is the
 * queue's side of it.
 *
 * A transient provider failure throws and is retried by the queue. A switch
 * turned off, or a key not set, is a skip and not a failure: a job queued
 * before an operator turned the feature off should finish quietly, not fill the
 * dead queue.
 */
export async function classifyPriority(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'classify_priority');
  const result = await classifyMessagePriority(messageId);

  switch (result.status) {
    case 'gone':
      throw subjectGone('classify_priority', `message ${messageId}`);
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
