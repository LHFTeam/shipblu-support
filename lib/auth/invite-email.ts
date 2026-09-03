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
 * every log line (`send_notification_email` logs the recipient and the
 * Message-ID, never the body).
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
  /** The name the admin typed, when they typed one. */
  name: string | null;
  /** The admin who created the invite. */
  invitedByName: string | null;
  expiresAt: Date;
}): InviteEmailBody {
  // "Hi," rather than "Hi ," — name is optional on the invite form, so the
  // greeting has to survive its absence.
  const greeting = name ? `Hi ${name},` : 'Hi,';

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
    htmlBody: wrap([
      `<p>${escapeHtml(greeting)}</p>`,
      `<p>${escapeHtml(inviter)} to join the ShipBlu Support team console — the tool the team answers customer tickets in.</p>`,
      // A styled anchor rather than a <button>: a button in an email is a form
      // control that does nothing, and Outlook strips it. Padding and a
      // background on an <a> is the call-to-action every client renders.
      // #1558ad is `--color-brand-600` resolved to hex. It is written out
      // rather than referenced because an email is not the app: no client
      // supports a CSS variable, and Outlook and Gmail do not support oklch —
      // both would drop the declaration and render a white-on-white button.
      // So this is a copy that has to be updated by hand if the brand moves.
      `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1558ad;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">Activate your account</a></p>`,
      // The bare URL below the button, because a proportion of clients render
      // the anchor without making it clickable and the recipient is then
      // holding a message with no way to act on it.
      `<p style="color:#666;font-size:13px">If the button does not work, copy this link into your browser:<br /><span style="word-break:break-all">${escapeHtml(url)}</span></p>`,
      `<p style="color:#666;font-size:13px">${escapeHtml(expiry)} If you were not expecting this, ignore the email — the account is not created until you set a password.</p>`,
      '<p>ShipBlu Support</p>',
    ]),
  };
}

/** Minimal HTML: paragraphs, one link, a note. Every client renders it the same. */
function wrap(lines: string[]): string {
  return [
    `<div lang="en" style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#111">`,
    ...lines,
    '</div>',
  ].join('\n');
}

/**
 * Interpolated values are escaped rather than sanitised, and deliberately not
 * through `lib/html/sanitize.ts`: that module's job is to keep attacker HTML
 * *renderable but safe*, which is the right answer for an email body somebody
 * sent us. Here the values are a name, an inviter and a URL — none of which
 * has any business carrying markup at all — so the whole answer is to escape
 * them and let a stray `<` show up as a `<`.
 *
 * An admin types the name, so this is not a hostile input so much as one nobody
 * validates: `O'Brien <ops>` should not silently break the layout of the
 * message, and an apostrophe in a name is common enough to matter.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
