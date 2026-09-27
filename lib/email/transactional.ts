import { randomUUID } from 'node:crypto';
import { emailProvider } from '@/lib/email/providers';
import { formatMessageId } from '@/lib/email/threading';
import type { NotificationEmail } from '@/lib/email/notify';
import type { OutboundEmail } from '@/lib/email/types';
import { env, replyDomain } from '@/lib/env';
import { logger } from '@/lib/log';

/**
 * Puts one composed, ticket-less email on the wire.
 *
 * Shared by the two job handlers that send this kind of mail — the portal's
 * account links and the agent invitation — because the envelope is the part
 * they must agree on, not the part either of them is about. The `Reply-To` and
 * the `Auto-Submitted` header below are each load-bearing, and a second
 * handler reimplementing them slightly differently is how one of them stops
 * being true.
 *
 * `label` only names the caller in the log line, so a send can be traced back
 * to the job type that asked for it.
 */
export async function sendTransactionalEmail(
  email: NotificationEmail,
  label: string,
): Promise<void> {
  const e = env();
  if (!e.EMAIL_FROM_ADDRESS) throw new Error(`${label} requires EMAIL_FROM_ADDRESS`);

  const outbound: OutboundEmail = {
    to: [{ address: email.to }],
    from: { address: e.EMAIL_FROM_ADDRESS, name: e.EMAIL_FROM_NAME },
    // Not a plus-addressed reply token: a reply to a sign-in link is a person
    // asking for help, and it should open a normal ticket on the support
    // mailbox rather than thread onto a conversation that does not exist.
    replyTo: e.EMAIL_FROM_ADDRESS,
    subject: email.subject,
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    messageId: `${randomUUID()}@${replyDomain()}`,
    headers: {
      // Keeps autoresponders and out-of-office replies from bouncing back at
      // the support mailbox and opening a ticket per verification email.
      'Auto-Submitted': 'auto-generated',
    },
  };

  const result = await emailProvider().send(outbound);
  if (!result.accepted) throw new Error(`${label}: provider rejected ${email.to}`);

  // The recipient and the Message-ID, never the body: these messages carry
  // one-time links, and a log line is the one place a credential outlives the
  // thing it was minted for.
  logger(label).info(`sent ${formatMessageId(outbound.messageId)} to ${email.to}`);
}
