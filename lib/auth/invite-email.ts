import { emailButton, emailShell, escapeHtml } from '@/lib/email/html';
import type { NotificationEmail } from '@/lib/email/notify';
import { formatDateTime } from '@/lib/format';

/**
 * The email announcing an agent invite.
 *
 * English only, unlike `lib/portal/emails.ts`, which is written out per
 * language: this message goes to somebody who is about to work in the agent
 * console, and the console has no Arabic. Sending a bilingual invitation would
 * promise a bilingual product that does not exist — when the console gains a
 * locale, the second copy belongs here beside this one.
 *
 * `Omit<NotificationEmail, 'to'>` rather than a shape of its own so the builder
 * and the transport cannot drift: the address is the caller's to supply, and
 * everything else is decided here.
 */
export type InviteEmailBody = Omit<NotificationEmail, 'to'>;

/**
 * Built as a subject plus a body, with the link appearing exactly once as an
 * anchor and once as bare text.
 *
 * **The link is a credential** — it is the only thing standing between an
 * inbox and an agent account with this invite's role. So it stays out of the
 * subject, which is what a mail client prints on a lock screen and what a
 * mailing-list archive or a notification relay keeps a copy of, and out of
 * every log line (`sendTransactionalEmail` logs the recipient and the
 * Message-ID, never the body). It is also why this is called from
 * `send_agent_invite` rather than at enqueue time: the rendered link must not
 * be what sits in `jobs.payload`.
 *
 * `invitedByName` is not decoration. An unexpected "set a password" link is
 * indistinguishable from a phishing attempt, and naming the colleague who sent
 * it is the one thing in the message a recipient can check against something
 * they already know.
 */
export function inviteEmail({
  url,
  name,
  invitedByName,
  expiresAt,
}: {
  url: string;
  /** The name the admin typed. `invites.name` is NOT NULL, so there is one. */
  name: string;
  /**
   * The admin who created the invite. Optional where `name` is not, because
   * `invites.invited_by_agent_id` is `on delete set null` — an invitation
   * rebuilt from a row whose author has since left has nobody to name.
   */
  invitedByName: string | null;
  expiresAt: Date;
}): InviteEmailBody {
  const greeting = `Hi ${name},`;

  const inviter = invitedByName ? `${invitedByName} has invited you` : 'You have been invited';

  // The row's own timestamp, formatted the same way the pending-invites screen
  // formats it, so the date the invitee reads is the date the admin sees rather
  // than a TTL restated in prose that drifts when the TTL changes.
  const expiry = `This invitation expires on ${formatDateTime(expiresAt)} (Cairo time).`;

  return {
    subject: 'You have been invited to ShipBlu Support',
    textBody: [
      greeting,
      '',
      `${inviter} to join the ShipBlu Support team console — the tool the team answers customer tickets in.`,
      '',
      'Open this link to activate your account and choose a password:',
      url,
      '',
      expiry,
      'If you were not expecting this, ignore the email — the account is not created until you set a password.',
      '',
      'ShipBlu Support',
    ].join('\n'),
    htmlBody: emailShell([
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(inviter)} to join the ShipBlu Support team console — the tool the team answers customer tickets in.</p>`,
      ...emailButton(url, 'Activate your account'),
      `<p style="color:#666;font-size:13px">${escapeHtml(expiry)} If you were not expecting this, ignore the email — the account is not created until you set a password.</p>`,
      '<p>ShipBlu Support</p>',
    ]),
  };
}
