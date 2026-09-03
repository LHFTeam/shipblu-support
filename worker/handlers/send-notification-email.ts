import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emailProvider } from '@/lib/email/providers';
import { formatMessageId } from '@/lib/email/threading';
import type { OutboundEmail } from '@/lib/email/types';
import { env, replyDomain } from '@/lib/env';
import type { ClaimedJob } from '@/lib/queue';

/**
 * Sends one transactional email that does not belong to a ticket — today, the
 * customer portal's verification and password-reset links, and the agent
 * invitation.
 *
 * The body arrives in the payload rather than being rendered here, because the
 * caller is the only place that knows what language to write in: which locale
 * the customer was reading for a portal link, and English for an invitation to
 * a console that has none.
 */

const payloadSchema = z.object({
  to: z.email(),
  subject: z.string().min(1),
  textBody: z.string().min(1),
  htmlBody: z.string().min(1),
});

export async function sendNotificationEmail(job: ClaimedJob): Promise<void> {
  const payload = payloadSchema.safeParse(job.payload);
  if (!payload.success) {
    // A malformed payload will never succeed on retry, so fail it here with a
    // message naming the field rather than burning five attempts on it.
    throw new Error(`send_notification_email: invalid payload — ${payload.error.message}`);
  }

  const e = env();
  if (!e.EMAIL_FROM_ADDRESS) {
    throw new Error('send_notification_email requires EMAIL_FROM_ADDRESS');
  }

  const outbound: OutboundEmail = {
    to: [{ address: payload.data.to }],
    from: { address: e.EMAIL_FROM_ADDRESS, name: e.EMAIL_FROM_NAME },
    // Not a plus-addressed reply token: a reply to a sign-in link is a person
    // asking for help, and it should open a normal ticket on the support
    // mailbox rather than thread onto a conversation that does not exist.
    replyTo: e.EMAIL_FROM_ADDRESS,
    subject: payload.data.subject,
    textBody: payload.data.textBody,
    htmlBody: payload.data.htmlBody,
    messageId: `${randomUUID()}@${replyDomain()}`,
    headers: {
      // Keeps autoresponders and out-of-office replies from bouncing back at
      // the support mailbox and opening a ticket per verification email.
      'Auto-Submitted': 'auto-generated',
    },
  };

  const result = await emailProvider().send(outbound);
  if (!result.accepted) {
    throw new Error(`send_notification_email: provider rejected ${payload.data.to}`);
  }

  console.log(
    `[send_notification_email] sent ${formatMessageId(outbound.messageId)} to ${payload.data.to}`,
  );
}
