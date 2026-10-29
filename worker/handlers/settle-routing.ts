import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';
import { settleRouting } from '@/lib/routing/apply';
import { subjectGone } from './subject-gone';

const log = logger('settle_routing');

/**
 * The end of one ticket's routing window: decide whatever is there — Jev's
 * category, a person's or a rule's, or none (`fallback`) — then assign the
 * ticket and send the reply the hold kept back (`plans/ticket-category-routing.md`,
 * decision 5).
 *
 * Enqueued in the ticket's insert transaction for the instant its window
 * closes, keyed on the ticket and so once ever. A late answer from Jev finds
 * the ticket decided and leaves it where it is. A ticket decided already — by
 * Jev, a person or a rule — is nothing to do.
 *
 * Also completes a decision whose caller died between its phases, or whose
 * last step failed — running its rules only if nobody has claimed them, so a
 * retry never runs them twice, and looking again later, without a key, while
 * a claimant may still be running them. When that caller is this job,
 * `settleRouting` throws and the queue retries it: nothing else would ever
 * come for the ticket, whose key this run spends. If the job itself ever
 * dies, `npm run job -- settle_routing conversationId=…` runs it by hand,
 * which needs no key.
 */
export async function settleRoutingJob(job: ClaimedJob): Promise<void> {
  const { conversationId } = parseJobPayload(job, 'settle_routing');
  const result = await settleRouting(conversationId);
  if (result === 'gone') throw subjectGone('settle_routing', `conversation ${conversationId}`);
  log.info(result, { conversationId });
}
