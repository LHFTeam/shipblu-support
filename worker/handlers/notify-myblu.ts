import {
  decideMessageCreated,
  deliverWebhook,
  readMessageSubject,
  webhookTarget,
} from '@/lib/api/webhook';
import { logger } from '@/lib/log';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { subjectGone } from './subject-gone';

const log = logger('notify_myblu');

/**
 * Tells myBlu's backend that the team wrote on one of its users' tickets, so
 * it can push to the user's phone (`plans/myblu-ticket-api.md`, _The webhook_).
 * Queued by `enqueueMessageCreated` (`lib/api/notify.ts`) from the two doors
 * every outbound reply passes, once ever per message.
 *
 * In this order, each answer final for the attempt:
 *
 * 1. **The switch, read now.** `MYBLU_WEBHOOK_URL` unset completes the job with
 *    nothing sent, so unsetting it stops the jobs already queued — the way
 *    back. Set but unusable — not `https`, userinfo or a query string in it,
 *    no secret of 32 characters — fails the attempt by name, a plain error the
 *    queue retries, so a value corrected within the job's day still sends.
 * 2. **The message, re-read.** Gone is `subjectGone`. Not a reply from the team
 *    on the myBlu app is `PermanentJobError`, since only a payload written by
 *    hand names one, and sending it would carry a note's existence out.
 * 3. **Whether the app could open what the push points at**, and whether it is
 *    still within its day (`decideMessageCreated`): otherwise the job completes
 *    with nothing sent, and says why.
 * 4. **One signed attempt.** Anything but a `2xx` within ten seconds is a plain
 *    error and the queue's retry, never `PermanentJobError`.
 *
 * It never writes to the message: a push that never lands leaves the reply
 * delivered, since the app's poll reads it either way.
 */
export async function notifyMyblu(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'notify_myblu');
  const { messageId } = payload;

  const target = webhookTarget();
  if (target.kind === 'off') {
    log.info('MYBLU_WEBHOOK_URL is unset — nothing sent', { messageId });
    return;
  }
  if (target.kind === 'refused') {
    throw new Error(`notify_myblu: ${target.reason} — nothing sent`);
  }

  const subject = await readMessageSubject(messageId);
  if (!subject) throw subjectGone('notify_myblu', `message ${messageId}`);

  const now = new Date();
  const decision = decideMessageCreated(subject, now);
  switch (decision.kind) {
    case 'refuse':
      throw new PermanentJobError(`notify_myblu: message ${messageId} is ${decision.reason}`);
    case 'quiet':
      log.info('nothing sent', { messageId, reason: decision.reason });
      return;
    case 'send':
      await deliverWebhook(target.target, decision.event, now);
      return;
  }
}
