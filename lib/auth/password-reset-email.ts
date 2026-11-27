import { emailButton, emailShell, escapeHtml } from '@/lib/email/html';
import type { NotificationEmail } from '@/lib/email/notify';
import { formatDateTime } from '@/lib/format';

/**
 * The two emails an agent's forgotten password sends.
 *
 * English only, for the reason `invite-email.ts` gives: they go to somebody
 * who works in the console, and the console has no Arabic.
 */
type ResetEmailBody = Omit<NotificationEmail, 'to'>;

/**
 * The link, once as a button and once as bare text, and never in the subject.
 *
 * **The link is a credential**: for an hour it is the agent's account. So it
 * stays out of the subject, which a lock screen prints, and this is built in
 * `send_agent_password_reset` rather than where the reset is asked for, so the
 * rendered link is never what sits in `jobs.payload`.
 *
 * It says that somebody asked rather than that "you" did, because the person
 * reading is often not the person who typed the address, and it says what
 * ignoring it costs — nothing — because that is the question an unexpected
 * reset email raises.
 */
export function agentPasswordResetEmail({
  url,
  name,
  expiresAt,
}: {
  url: string;
  name: string;
  expiresAt: Date;
}): ResetEmailBody {
  const greeting = `Hi ${name},`;
  const asked =
    'Somebody asked to reset the password for your ShipBlu Support account. To choose a new one, open this link:';
  // The row's own instant, as the invitation prints its expiry, rather than a
  // TTL restated in prose that drifts when the TTL changes.
  const expiry = `The link works once and expires on ${formatDateTime(expiresAt)} (Cairo time). Using it signs you out everywhere.`;
  const ignore =
    'If you did not ask for this, ignore the email — your current password is unchanged.';

  return {
    subject: 'Reset your ShipBlu Support password',
    textBody: [greeting, '', asked, url, '', expiry, ignore, '', 'ShipBlu Support'].join('\n'),
    htmlBody: emailShell([
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(asked)}</p>`,
      ...emailButton(url, 'Choose a new password'),
      `<p style="color:#666;font-size:13px">${escapeHtml(expiry)} ${escapeHtml(ignore)}</p>`,
      '<p>ShipBlu Support</p>',
    ]),
  };
}

/**
 * Sent when a link is redeemed.
 *
 * It carries no link at all, deliberately. That is what lets it travel in
 * `send_notification_email`'s payload, and a "was this you?" email with a
 * button in it is the shape of the phishing message it would be mistaken for.
 */
export function passwordChangedEmail({ name }: { name: string }): ResetEmailBody {
  const greeting = `Hi ${name},`;
  const changed =
    'The password for your ShipBlu Support account was just changed using a reset link sent to this address, and every device was signed out.';
  const notYou =
    'If this was not you, tell an administrator now so they can deactivate the account.';

  return {
    subject: 'Your ShipBlu Support password was changed',
    textBody: [greeting, '', changed, '', notYou, '', 'ShipBlu Support'].join('\n'),
    htmlBody: emailShell([
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(changed)}</p>`,
      `<p>${escapeHtml(notYou)}</p>`,
      '<p>ShipBlu Support</p>',
    ]),
  };
}
