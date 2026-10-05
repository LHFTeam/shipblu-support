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
 * The subject a new thread opens with: `1212121212121 || `, leaving the agent to
 * type only what they are asking.
 *
 * The tracking number leads because it is what a hub sorts its shared inbox by
 * and searches it for — the `[#123]` that `buildSideSubject` appends is our
 * number, not theirs — and, as in the body, a number the agent never retypes is
 * one they cannot transpose.
 *
 * Only for exactly one parcel. With none there is nothing to lead with, and with
 * several, picking one would file a question about all of them under whichever
 * the list happened to put first — so the field stays empty and the agent
 * says which they mean. `trackingPrefill` names every one of them in the body
 * either way.
 */
export function subjectPrefill(trackingNumbers: string[]): string {
  const distinct = [...new Set(trackingNumbers.filter(Boolean))];
  return distinct.length === 1 ? `${distinct[0]} || ` : '';
}

/**
 * What a thread is called when the agent leaves its subject empty: the
 * ticket's own, or `(no subject)` when the ticket has none worth the name.
 *
 * One function because two places state it — the action sends it and the
 * composer shows it as the field's placeholder — and the placeholder exists to
 * say what a blank field will send. Trimmed here rather than left to
 * `buildSideSubject`, which would turn a whitespace subject into `(no subject)`
 * in the mail while the thread card went on showing the whitespace.
 */
export function blankSideSubject(ticketSubject: string | null): string {
  return ticketSubject?.trim() || '(no subject)';
}

/**
 * The subject a new thread is sent with, from what the agent left in the field.
 *
 * A prefill sent untouched is the tracking number and a separator with nothing
 * after it, and the hub would read `1212121212121 ||` with the `||` dangling —
 * so a trailing `||` is dropped and the number goes out on its own. Nothing is
 * invented in its place: the agent did not write anything there. A field that
 * was nothing but the separator is empty, and gets `blankSideSubject`.
 */
export function sideSubject(typed: string, ticketSubject: string | null): string {
  const subject = typed.trim().replace(/\s*\|\|$/, '');
  return subject || blankSideSubject(ticketSubject);
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
