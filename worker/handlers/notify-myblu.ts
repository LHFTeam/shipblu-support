import { apiSwitchedOn } from '@/lib/api/auth';
import {
  decideMessageCreated,
  decideSurveyCreated,
  deliverWebhook,
  readMessageSubject,
  readSurveySubject,
  webhookTarget,
  type Decision,
} from '@/lib/api/webhook';
import { logger } from '@/lib/log';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { subjectGone } from './subject-gone';

const log = logger('notify_myblu');

/**
 * Tells myBlu's backend that something on one of its users' tickets is waiting
 * for them, so it can push to the user's phone (`plans/myblu-ticket-api.md`,
 * _The webhook_): `message.created` for a reply from the team, queued by
 * `enqueueMessageCreated` (`lib/api/notify.ts`) from the two doors every
 * outbound reply passes, and `survey.created` for a survey the app pulls,
 * queued by `enqueueSurveyCreated` from `sendSurvey` in the transaction that
 * writes it. Each once ever per subject.
 *
 * In this order, each answer final for the attempt:
 *
 * 1. **The switch, read now.** `MYBLU_WEBHOOK_URL` unset completes the job with
 *    nothing sent, before any query, so unsetting it stops the jobs already
 *    queued — the way back — whatever their subjects became.
 * 2. **The subject, re-read.** Gone is `subjectGone`. A message that is not a
 *    reply from the team on the myBlu app, or a survey the app does not pull,
 *    is `PermanentJobError`, since only a payload written by hand names one,
 *    and sending it would carry a note's existence out.
 * 3. **Whether the app could open what the push points at**, whether a survey
 *    is still waiting for its answer, and whether it is still within its day
 *    (`decideMessageCreated`, `decideSurveyCreated`): otherwise the job
 *    completes with nothing sent, and says why — a stale one at `warn`, since
 *    that is how a delivery resent by hand too late (`lib/queue/payloads.ts`)
 *    says it sent nothing.
 * 4. **Whether the API itself is on** (`apiSwitchedOn`). Off fails the attempt,
 *    a plain error the queue retries, since the reply or the survey is there
 *    for the app once it comes back on: completed, a token unset for the
 *    minutes of a rotation lost every push in them. Off for longer than the
 *    job's seventeen hours, the job goes `dead`; switching the API off for
 *    good, unset `MYBLU_WEBHOOK_URL` too, which completes them.
 * 5. **The target**, only now there is something to send. Set but unusable —
 *    not `https`, userinfo or a query string in it, no secret of 32
 *    characters — fails the attempt by name, a plain error the queue retries,
 *    so a value corrected within the job's day still sends. Asked before the
 *    subject, it sent to `dead`, over a wrong value, jobs whose only outcome
 *    was nothing sent: a purged message, a withdrawn ticket, a stale event.
 * 6. **One signed attempt.** Anything but a `2xx` within ten seconds is a plain
 *    error and the queue's retry, never `PermanentJobError`.
 *
 * It never writes to the subject: a push that never lands leaves the reply
 * delivered and the survey waiting, since the app's poll reads both either way.
 */
export async function notifyMyblu(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'notify_myblu');
  const fields =
    payload.event === 'message.created'
      ? { messageId: payload.messageId }
      : { surveyId: payload.surveyId };

  const target = webhookTarget();
  if (target.kind === 'off') {
    log.info('MYBLU_WEBHOOK_URL is unset — nothing sent', fields);
    return;
  }

  const now = new Date();
  const apiOn = apiSwitchedOn();
  let decision: Decision<{ id: string; type: string }>;
  let subjectName: string;
  if (payload.event === 'message.created') {
    subjectName = `message ${payload.messageId}`;
    const subject = await readMessageSubject(payload.messageId);
    if (!subject) throw subjectGone('notify_myblu', subjectName);
    decision = decideMessageCreated(subject, now, apiOn);
  } else {
    subjectName = `survey ${payload.surveyId}`;
    const subject = await readSurveySubject(payload.surveyId);
    if (!subject) throw subjectGone('notify_myblu', subjectName);
    decision = decideSurveyCreated(subject, now, apiOn);
  }

  switch (decision.kind) {
    case 'refuse':
      throw new PermanentJobError(`notify_myblu: ${subjectName} is ${decision.reason}`);
    case 'quiet':
      if (decision.reason === 'stale') {
        log.warn(`nothing sent: older than a day ${subjectName} reason=stale`);
      } else {
        log.info('nothing sent', { ...fields, reason: decision.reason });
      }
      return;
    case 'later':
      throw new Error(
        'notify_myblu: the API is switched off (MYBLU_API_TOKEN unset or short) — nothing sent',
      );
    case 'send':
      if (target.kind === 'refused') {
        throw new Error(`notify_myblu: ${target.reason} — nothing sent`);
      }
      await deliverWebhook(target.target, decision.event, now);
      return;
  }
}
