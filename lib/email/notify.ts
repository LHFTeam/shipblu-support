import { enqueueMany, type EnqueueOptions } from '@/lib/queue';

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

type NotificationOptions = Pick<EnqueueOptions, 'on' | 'priority'>;

export async function enqueueNotificationEmail(
  email: NotificationEmail,
  options: NotificationOptions = {},
): Promise<void> {
  await enqueueNotificationEmails([email], options);
}

/** Several in one insert, for a caller holding a lock while it queues them. */
export async function enqueueNotificationEmails(
  emails: NotificationEmail[],
  options: NotificationOptions = {},
): Promise<void> {
  // Priority 40 by default: ahead of ticket replies (50), because somebody is
  // sitting on a form waiting for a sign-in link. A caller nobody is waiting
  // on — a low rating's alert — names a later one, and queues on its own
  // transaction where the email belongs to a row it writes. `??`, not a
  // spread over the default: a priority passed as undefined would override it
  // and queue a sign-in link at the queue's 100.
  await enqueueMany(
    'send_notification_email',
    emails.map((email) => ({ ...email })),
    { on: options.on, priority: options.priority ?? 40 },
  );
}
