import { enqueue } from '@/lib/queue';

/**
 * Transactional mail that is not part of a ticket.
 *
 * Everything else this app sends belongs to a conversation and goes out through
 * `send_email`, which reads the message row and threads the reply. A portal
 * verification link has no conversation and must never create one — a customer
 * confirming their address is not asking a question — so it takes its own job
 * type with the body carried in the payload.
 *
 * The agent invitation is the same shape and does *not* come through here: a
 * rendered activation link in `jobs.payload` is a live credential at rest, so
 * `send_agent_invite` carries the invite's id and builds the body in the
 * worker. Anything added to this path inherits that trade-off — a one-time link
 * in the payload outlives the job by seven days, and forever if it dies.
 *
 * Queued rather than sent inline so that a slow provider cannot stall the form
 * submission the customer is waiting on, and so a transient failure is retried
 * by the same backoff as everything else.
 */
export type NotificationEmail = {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
};

export async function enqueueNotificationEmail(email: NotificationEmail): Promise<void> {
  // Priority 40: ahead of ticket replies (50). Somebody is sitting on a form
  // waiting for this link, which is not true of any other outbound mail.
  await enqueue('send_notification_email', { ...email }, { priority: 40 });
}
