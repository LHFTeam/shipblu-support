import { sendTransactionalEmail } from '@/lib/email/transactional';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';

/**
 * Sends one transactional email that is no message on a ticket's thread — the
 * customer portal's verification and password-reset links, the admin's survey
 * test, and a low rating's alert to the supervisors (`notify_low_rating`).
 *
 * The body arrives in the payload rather than being rendered here, because the
 * caller is the only place that knows which locale the customer was reading
 * when they asked for it.
 *
 * That does mean the payload holds the one-time link in plaintext for as long
 * as `cleanup` keeps the row. The agent invitation deliberately does not use
 * this path for that reason — see `send-agent-invite.ts`, which carries an id
 * and rebuilds the link from the encrypted copy. Bringing the portal's two
 * emails across is worth doing and is not this change.
 */

export async function sendNotificationEmail(job: ClaimedJob): Promise<void> {
  // A malformed payload will never succeed on retry, so fail it here with a
  // message naming the field rather than burning five attempts on it.
  const payload = parseJobPayload(job, 'send_notification_email');

  await sendTransactionalEmail(payload, 'send_notification_email');
}
