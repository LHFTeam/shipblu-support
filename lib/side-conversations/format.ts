import { stripSubjectPrefixes } from '@/lib/email/threading';

/**
 * The words a side conversation puts in front of a hub.
 *
 * Kept apart from the send handler because the composer previews the same
 * strings, and a footer that differs between the preview and the delivered mail
 * is how an agent learns not to trust the preview.
 */

/**
 * The subject a hub actually receives.
 *
 * Three things, in this order, and each earns its place:
 *
 *  - what the agent asked about, so the mail is legible in a busy shared inbox;
 *  - `[#123]`, the bare ticket number, unsigned and purely for humans — a hub
 *    leader forwarding this to a colleague says "the 123 one" and everyone can
 *    find it;
 *  - `[#S4.sig]`, the signed side tag, which is the machine's last-resort route
 *    home when a forwarder has eaten both the plus-address and References.
 */
export function buildSideSubject(
  subject: string,
  conversationNumber: number,
  sideTag: string,
): string {
  const base = stripSubjectPrefixes(subject).trim() || '(no subject)';
  return `${base} [#${conversationNumber}] ${sideTag}`;
}

/** Kept stable across a thread, so a hub's client groups the exchange. */
export function buildSideReplySubject(
  subject: string,
  conversationNumber: number,
  sideTag: string,
): string {
  return `Re: ${buildSideSubject(subject, conversationNumber, sideTag)}`;
}

/**
 * Said at the foot of every outbound side conversation message.
 *
 * The recipient is a colleague at a hub, not a support professional: they have
 * no idea what this system is, whether hitting reply reaches a person, or
 * whether the customer is reading over their shoulder. All three questions are
 * answered before they can be asked, because the alternative is a hub leader
 * hedging their answer — and the hedge is exactly the detail the agent needed.
 */
export function sideConversationFooter(conversationNumber: number): string {
  return [
    'Reply to this email and your answer reaches the ShipBlu support team on',
    `ticket #${conversationNumber}. The customer cannot see this thread.`,
  ].join(' ');
}

/**
 * The customer's message, quoted into the question.
 *
 * Trimmed hard. The point is to give the hub the sentence that prompted the
 * question — "it's been four days and nobody called" — not to forward a thread
 * they have no context for and will not read.
 */
export function quoteAnchor(authorName: string | null, bodyText: string, at: Date): string {
  const trimmed = bodyText.trim().replace(/\n{3,}/g, '\n\n');
  const clipped = trimmed.length > 1200 ? `${trimmed.slice(0, 1200).trimEnd()}…` : trimmed;
  const who = authorName ?? 'The customer';

  return [
    `--- ${who} wrote on ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC ---`,
    clipped
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  ].join('\n');
}

/**
 * The shipments a ticket is already about, offered as the opening line.
 *
 * An agent should never retype a tracking number they are looking at — it is the
 * one field in this business where a transposed digit sends a hub looking for
 * somebody else's parcel.
 */
export function trackingPrefill(trackingNumbers: string[]): string {
  if (trackingNumbers.length === 0) return '';
  const label = trackingNumbers.length > 1 ? 'Shipments' : 'Shipment';
  return `${label}: ${trackingNumbers.join(', ')}\n\n`;
}

/**
 * How the recipient is named on screen, however the agent chose it.
 *
 * Here rather than beside the read model it describes, for the reason already
 * written on `FILTERABLE_CHANNELS` in `lib/tickets/channel-policy.ts`: the
 * timeline card is a client component, and importing a *value* from a module
 * that touches `db/client` pulls the Postgres driver and `fs` into the browser
 * bundle and fails the build. Types are erased and can come from anywhere;
 * functions cannot.
 */
export function describeRecipient(side: {
  recipientName: string | null;
  toAddresses: string[];
}): string {
  return side.recipientName ?? side.toAddresses[0] ?? 'Unknown recipient';
}
