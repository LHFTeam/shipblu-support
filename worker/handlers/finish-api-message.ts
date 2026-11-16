import { owedFor, finishStored } from '@/lib/api/finish';
import { logger } from '@/lib/log';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { subjectGone } from './subject-gone';

const log = logger('finish_api_message');

/**
 * The work owed a message from the myBlu app, when the request that stored it
 * never took it (`lib/api/finish.ts`): written in the message's transaction,
 * due a minute later, and taken by the request in the ordinary case, so this
 * runs only after a request that ended between its commit and that work.
 *
 * Once. A second attempt follows one that may have begun the work — a worker
 * stopped mid-run, which the stalled sweep returns — or one that failed reading
 * the message, and nothing records which; so it is not run again, and says so,
 * since a rule's reply sent twice is the larger harm (`settle_routing` answers
 * a dead claimant's rules the same way). A message purged since is
 * `subjectGone`.
 */
export async function finishApiMessage(job: ClaimedJob): Promise<void> {
  const { messageId } = parseJobPayload(job, 'finish_api_message');
  if (job.attempts > 1) {
    log.warn(`not run again after an attempt that may have begun it message_id=${messageId}`);
    return;
  }
  const owed = await owedFor(messageId);
  if (!owed) throw subjectGone('finish_api_message', `message ${messageId}`);
  await finishStored(owed);
  log.info('finished', { messageId, created: owed.created });
}
