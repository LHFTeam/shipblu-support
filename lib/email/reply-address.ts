import { env, replyDomain } from '@/lib/env';
import { buildReplyAddress, buildSideReplyAddress } from './threading';

/**
 * Which address outbound mail invites the answer back to.
 *
 * Deliberately not the same question as "which addresses do we thread on".
 * `resolveThread` accepts a plus-addressed token wherever one turns up and
 * always will; this decides only whether we *advertise* one, and the asymmetry
 * is the point. Accepting costs nothing and keeps every token already sitting in
 * somebody's mailbox working. Advertising an address the mail path will not
 * deliver costs the reply.
 *
 * Which it does here. `shipblu.com`'s MX is Zoho, and the route into this system
 * is a Zoho forwarding rule on the single address `help-support@shipblu.com`
 * pointing at Postmark's inbound endpoint. `help-support+s3.<sig>@shipblu.com` is
 * not that address and is not a Zoho mailbox, so it never reaches the rule: the
 * hub's answer bounced back to them and the ticket was never told. That was the
 * first outbound email this system ever sent to a real recipient, which is why a
 * design flaw shipped in August surfaced on 2026-09-01 — nothing had ever
 * exercised a Reply-To before. `docs/PROJECT-STATE.md` §6.41.
 *
 * So the token is off unless a deployment sets `EMAIL_REPLY_PLUS_ADDRESSING`,
 * having actually checked, and the fallback is `EMAIL_FROM_ADDRESS` itself —
 * the one address that is provably deliverable, because we just sent from it.
 * Not `<mailbox>@<reply domain>`: those two are only the same string while
 * `EMAIL_REPLY_DOMAIN` is unset or agrees with the from address, and a Reply-To
 * assembled out of two independent settings is a guess. `send-notification-email`
 * has always answered this question that way; this makes the other two agree.
 *
 * What the fallback gives up is real and worth stating: with no token in the
 * address, a reply threads on References or on the signed `[#S3.<sig>]` subject
 * tag, and a client that strips both opens a new ticket. Both survive ordinary
 * reply and forward, and both were exercised end to end when the feature landed,
 * so this trades a rare mis-file for the certain bounce it replaces.
 */

export type ReplyThread =
  { kind: 'ticket'; conversationNumber: number } | { kind: 'side'; sideNumber: number };

/** Has this deployment confirmed sub-addressed mail reaches the webhook? */
export function plusAddressingEnabled(): boolean {
  return env().EMAIL_REPLY_PLUS_ADDRESSING === 'true';
}

export function replyToAddress(thread: ReplyThread): string {
  const e = env();

  // The caller checks this first and fails the job with a sentence naming the
  // variable; reaching here without it is a programming error, not a
  // misconfiguration, so it throws rather than inventing a sender.
  if (!e.EMAIL_FROM_ADDRESS) {
    throw new Error('EMAIL_FROM_ADDRESS is not configured');
  }

  if (!plusAddressingEnabled()) return e.EMAIL_FROM_ADDRESS;

  const domain = replyDomain();
  const mailbox = e.EMAIL_FROM_ADDRESS.split('@')[0] ?? 'support';

  return thread.kind === 'side'
    ? buildSideReplyAddress(thread.sideNumber, e.APP_SECRET, mailbox, domain)
    : buildReplyAddress(thread.conversationNumber, e.APP_SECRET, mailbox, domain);
}
