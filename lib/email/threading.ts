import { createHmac } from 'node:crypto';
import type { EmailAddress, ParsedInboundEmail } from './types';

/**
 * Threading: deciding whether an inbound email continues an existing ticket,
 * continues a side conversation, or starts a new one. This is where naive
 * helpdesks break, so it uses three independent signals in descending order of
 * reliability.
 *
 *   1. Plus-addressed reply token   — we put it there; survives subject edits,
 *                                     forwards and clients that drop References.
 *   2. In-Reply-To / References     — standards-compliant; survives the customer
 *                                     changing the subject line.
 *   3. `[#123]` subject token       — last resort; survives clients that strip
 *                                     both of the above (some mobile clients do).
 *
 * A ticket number alone is never trusted: it is a small integer, so accepting it
 * unsigned would let anyone read or write another customer's ticket by guessing.
 * Both the reply token and the subject token are HMAC-verified.
 *
 * ## Side conversations
 *
 * A side conversation — the thread an agent opens with a hub or another internal
 * team — gets the same three signals with an `s` prefix instead of `c`, and its
 * matches are returned *ahead* of the ticket ones. Two properties are doing real
 * work here:
 *
 *  - **The prefixes are domain-separated in the HMAC, not just in the text.**
 *    The signed input is `side:12`, never `12`. Signing the bare number would
 *    mean the signature on ticket #12's reply address is also a valid signature
 *    for side conversation #12 — so every customer who has ever received a reply
 *    would be holding a working token for an internal thread. Rewriting one
 *    character of an address they already have is not a difficult attack.
 *
 *  - **Side matches win.** A hub replying to a side conversation quotes our
 *    Message-ID, and that message is not in `messages` at all, so the two
 *    signals cannot both fire on real mail. Checking side first is what makes
 *    the ambiguous case — a mangled forward that carries both — resolve to the
 *    internal thread rather than to the customer's ticket, which is the safe
 *    direction: a hub's answer filed on the ticket timeline is visible to the
 *    customer through the portal.
 */

/**
 * Truncated HMAC, in lowercase hex. 16 hex chars = 64 bits, which is far beyond
 * guessable for a value that is only checked server-side.
 *
 * Hex rather than base64url specifically because this travels in an email
 * local-part. RFC 5321 says local-parts are case-sensitive, but plenty of
 * intermediaries lowercase them anyway — with a case-sensitive encoding that
 * silently breaks threading for some senders and not others.
 */
const SIG_LENGTH = 16;

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, SIG_LENGTH);
}

/**
 * The signed input for a side conversation.
 *
 * A function rather than a template literal at each call site so the prefix
 * cannot drift between the builder and the parser — which would not fail loudly,
 * it would silently stop threading hub replies and start opening tickets from
 * them.
 */
function sideSubject(sideNumber: number | string): string {
  return `side:${sideNumber}`;
}

/**
 * Builds the local part of the reply address: `c<number>.<sig>`.
 *
 * HMAC rather than a stored random token: it needs no column, no lookup, and no
 * cleanup, and it cannot be forged without APP_SECRET.
 */
export function buildReplyToken(conversationNumber: number, secret: string): string {
  return `c${conversationNumber}.${sign(secret, String(conversationNumber))}`;
}

export function buildReplyAddress(
  conversationNumber: number,
  secret: string,
  mailbox: string,
  domain: string,
): string {
  return `${mailbox}+${buildReplyToken(conversationNumber, secret)}@${domain}`;
}

/** Returns the conversation number, or null if absent, malformed or unsigned. */
export function parseReplyToken(token: string, secret: string): number | null {
  const match = /^c(\d+)\.([a-fA-F0-9]+)$/.exec(token);
  if (!match) return null;

  const [, digits, signature] = match;
  if (!digits || !signature) return null;

  // Compared lowercased so a case-folding relay cannot break threading.
  if (signature.toLowerCase() !== sign(secret, digits)) return null;

  return Number.parseInt(digits, 10);
}

/** Pulls `c123.sig` or `s4.sig` out of `support+c123.sig@shipblu.com`. */
export function extractTokenFromAddress(address: string): string | null {
  const match = /^[^+@]+\+([^@]+)@/.exec(address.trim().toLowerCase());
  return match?.[1] ?? null;
}

/**
 * Builds the local part of a side conversation's reply address: `s<number>.<sig>`.
 *
 * A serial number rather than the row's uuid because this has to fit in an email
 * local part: `support+s<32 hex>.<16 hex>@` is 59 characters against RFC 5321's
 * 64-octet budget, before anyone picks a mailbox name longer than "support".
 */
export function buildSideReplyToken(sideNumber: number, secret: string): string {
  return `s${sideNumber}.${sign(secret, sideSubject(sideNumber))}`;
}

export function buildSideReplyAddress(
  sideNumber: number,
  secret: string,
  mailbox: string,
  domain: string,
): string {
  return `${mailbox}+${buildSideReplyToken(sideNumber, secret)}@${domain}`;
}

/** Returns the side conversation number, or null if absent, malformed or unsigned. */
export function parseSideReplyToken(token: string, secret: string): number | null {
  const match = /^s(\d+)\.([a-fA-F0-9]+)$/.exec(token);
  if (!match) return null;

  const [, digits, signature] = match;
  if (!digits || !signature) return null;

  if (signature.toLowerCase() !== sign(secret, sideSubject(digits))) return null;

  return Number.parseInt(digits, 10);
}

export function buildSideSubjectTag(sideNumber: number, secret: string): string {
  return `[#S${sideNumber}.${sign(secret, sideSubject(sideNumber))}]`;
}

export function parseSideSubjectTag(subject: string, secret: string): number | null {
  const match = /\[#S(\d+)\.([a-fA-F0-9]+)\]/i.exec(subject);
  if (!match) return null;

  const [, digits, signature] = match;
  if (!digits || !signature) return null;
  if (signature.toLowerCase() !== sign(secret, sideSubject(digits))) return null;

  return Number.parseInt(digits, 10);
}

export function buildSubjectTag(conversationNumber: number, secret: string): string {
  return `[#${conversationNumber}.${sign(secret, String(conversationNumber))}]`;
}

export function parseSubjectTag(subject: string, secret: string): number | null {
  const match = /\[#(\d+)\.([a-fA-F0-9]+)\]/.exec(subject);
  if (!match) return null;

  const [, digits, signature] = match;
  if (!digits || !signature) return null;
  if (signature.toLowerCase() !== sign(secret, digits)) return null;

  return Number.parseInt(digits, 10);
}

/**
 * Strips any number of stacked reply/forward prefixes, in the locales the team
 * actually sees. Used to keep a thread's subject stable rather than growing
 * "Re: Re: Fwd: Re:".
 */
export function stripSubjectPrefixes(subject: string): string {
  // Arabic clients often send "رد:" for Re: and "إعادة توجيه:" for Fwd:.
  const prefix = /^\s*(re|aw|sv|antwort|fwd|fw|tr|رد|إعادة توجيه)\s*(\[\d+\])?\s*:\s*/i;

  let result = subject;
  let previous: string;
  do {
    previous = result;
    result = result.replace(prefix, '');
  } while (result !== previous);

  return result.trim();
}

/** Builds the outbound subject, keeping the tag stable and un-duplicated. */
export function buildReplySubject(
  originalSubject: string | null,
  conversationNumber: number,
  secret: string,
): string {
  const base = stripSubjectPrefixes(originalSubject ?? '').replace(
    /\s*\[#\d+\.[a-fA-F0-9]+\]\s*/g,
    ' ',
  );
  const trimmed = base.trim() || '(no subject)';
  return `Re: ${trimmed} ${buildSubjectTag(conversationNumber, secret)}`;
}

export type ThreadMatch =
  | { kind: 'side_reply_token'; sideNumber: number }
  | { kind: 'reply_token'; conversationNumber: number }
  | { kind: 'references'; messageIds: string[] }
  | { kind: 'side_subject_tag'; sideNumber: number }
  | { kind: 'subject_tag'; conversationNumber: number }
  | { kind: 'none' };

/**
 * Resolves an inbound email to a thread, without touching the database.
 *
 * `references` is returned rather than resolved because matching those ids to
 * stored messages requires a query; the caller does that lookup — against
 * `side_conversation_messages` first and `messages` second, mirroring the
 * ordering of the token checks here. Keeping this function pure is what makes
 * the ordering rules straightforward to test.
 */
export function resolveThread(email: ParsedInboundEmail, secret: string): ThreadMatch {
  // 1. Reply token, across every field the address could arrive in. Providers
  //    vary in whether the plus-address survives into To vs Delivered-To.
  const candidates: string[] = [
    ...email.to.map((a) => a.address),
    ...email.cc.map((a) => a.address),
    ...(email.deliveredTo ?? []),
  ];

  // Side conversations are checked in their own pass rather than inside the loop
  // below, so a mail carrying both tokens — a hub forwarding our note back with
  // the customer's original still attached — resolves to the internal thread. A
  // hub's answer landing on the ticket timeline would be visible in the customer
  // portal, and that is the failure worth ordering around.
  for (const address of candidates) {
    const token = extractTokenFromAddress(address);
    if (!token) continue;
    const sideNumber = parseSideReplyToken(token, secret);
    if (sideNumber !== null) {
      return { kind: 'side_reply_token', sideNumber };
    }
  }

  for (const address of candidates) {
    const token = extractTokenFromAddress(address);
    if (!token) continue;
    const conversationNumber = parseReplyToken(token, secret);
    if (conversationNumber !== null) {
      return { kind: 'reply_token', conversationNumber };
    }
  }

  // 2. Standards-based threading, ordered newest ancestor first so the caller's
  //    first database hit is the most likely match. In-Reply-To is the direct
  //    parent, and References runs oldest → newest, so it is reversed.
  const ordered = [email.inReplyTo, ...[...email.references].reverse()].filter((id): id is string =>
    Boolean(id),
  );
  const messageIds = [...new Set(ordered)];
  if (messageIds.length > 0) {
    return { kind: 'references', messageIds };
  }

  // 3. Subject tag, side first for the reason above.
  const fromSideSubject = parseSideSubjectTag(email.subject, secret);
  if (fromSideSubject !== null) {
    return { kind: 'side_subject_tag', sideNumber: fromSideSubject };
  }

  const fromSubject = parseSubjectTag(email.subject, secret);
  if (fromSubject !== null) {
    return { kind: 'subject_tag', conversationNumber: fromSubject };
  }

  return { kind: 'none' };
}

/** `<abc@host>` → `abc@host`. Providers are inconsistent about the brackets. */
export function normaliseMessageId(id: string): string {
  return id.trim().replace(/^</, '').replace(/>$/, '');
}

export function formatMessageId(id: string): string {
  const bare = normaliseMessageId(id);
  return `<${bare}>`;
}

export function formatAddress(addr: EmailAddress): string {
  if (!addr.name) return addr.address;
  // Quote and escape: a display name containing a comma or quote would
  // otherwise corrupt the header and split into bogus recipients.
  const escaped = addr.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${addr.address}>`;
}
