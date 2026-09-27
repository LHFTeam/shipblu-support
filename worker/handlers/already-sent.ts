import type { messages } from '@/db/schema';

type DeliveryStatus = (typeof messages.$inferSelect)['deliveryStatus'];

/**
 * Whether a send job's message went out on an earlier attempt, so this attempt
 * must not send it again. Logs the skip when it has.
 *
 * Every send job can run more than once — a retry after a partial failure, a
 * job a deploy reclaimed mid-send — and the provider may already have accepted
 * the first attempt. A message still `pending`, or `failed` and being tried
 * again, has not gone. Anything further along has: `sent`, `delivered` and
 * `read` by definition, and `bounced` because the provider took it and the
 * recipient's server refused it, which another copy would not change. Sending
 * any of those again is a second copy in the customer's inbox.
 *
 * One copy because the four senders — email, side email, Meta and WhatsApp —
 * each wrote this condition out, and a sender that disagreed about which
 * statuses count would be the one that sends twice.
 */
export function alreadySent(job: string, messageId: string, status: DeliveryStatus): boolean {
  if (status === 'pending' || status === 'failed') return false;

  console.log(`[${job}] ${messageId} is ${status}, skipping`);
  return true;
}
