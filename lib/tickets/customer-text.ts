import { isReaction } from '@/lib/whatsapp/reaction';

/**
 * Whether a stored message carries words somebody wrote, rather than a label we
 * wrote for it.
 *
 * A photo, a voice note or a document sent without a caption is stored with our
 * own label as its `body_text` — `[image]`, `[voice note]`, `[2 attachments]`,
 * from the `displayText` in `lib/whatsapp/parse.ts` and `lib/meta/parse.ts`, and
 * `[empty comment]` from `lib/tickets/ingest-meta.ts` — so the console draws a
 * bubble rather than a blank. The label is English and it is ours, so anything
 * that reads a customer's last words for what they say has to look past it: the
 * priority classifier would ask a model about `[image]`, `requesterLocale` would
 * answer an Arabic customer in English for sending a photo of the damaged
 * parcel, and the ticket page would open its knowledge panel on a search for
 * "image".
 *
 * A label is recognised by its shape, one line in brackets, rather than from a
 * list, so a label of the same shape added to either parser is refused without
 * anybody remembering this. The price is a customer who sends nothing but a
 * word in brackets, read as having sent no words at all. Four labels wrap a
 * string from elsewhere — a document's file name, a pin's name and address,
 * Meta's reason for refusing a message, an edit's new words — which may hold a
 * bracket or a line break of its own, so those are recognised by how they open
 * instead (`WRAPPED_LABEL`).
 *
 * A WhatsApp edit is refused, whatever it says. Its label wraps the customer's
 * new words in ours, and reading the words with our wrapper still round them is
 * the worst of the answers: fourteen Latin letters outvote a short Arabic
 * correction, and a model is asked about our sentence. Unwrapping them buys
 * little, because an edit corrects a message the same person already sent: the
 * classifier asked about that message when it arrived, and a correction is
 * written in the language of what it corrects.
 *
 * Client-safe, for a page's own pick over rows it already holds. The same rule
 * for a query is `carriesCustomerText` in `lib/tickets/carries-customer-text.ts`,
 * built from the three constants below rather than spelled again, and
 * `carries-customer-text.db.test.ts` holds the two to the same answer.
 */
export function hasCustomerText(bodyText: string): boolean {
  const text = bodyText.trim();
  return text !== '' && !PLACEHOLDER.test(text) && !WRAPPED_LABEL.test(text);
}

/**
 * The newest message of a timeline, held oldest first as a ticket page holds
 * it, that carries the customer's own words: an inbound reply that is neither a
 * reaction nor our label. The pick `requesterLocale` makes in SQL, made over
 * rows in hand.
 */
export function lastCustomerWords<
  T extends { direction: string; kind: string; meta: unknown; bodyText: string },
>(timeline: readonly T[]): T | undefined {
  return timeline.findLast(
    (message) =>
      message.direction === 'inbound' &&
      message.kind === 'reply' &&
      !isReaction(message.meta) &&
      hasCustomerText(message.bodyText),
  );
}

/**
 * A ticket's subject, unless it is our label.
 *
 * A chat ticket's subject is the first line of its opening message, so one that
 * opened with a voice message is called `[audio]` — read as words, a search for
 * "audio". A label longer than a subject is cut before its closing bracket and
 * still gets through; a pin with a long address, mostly.
 */
export function subjectWords(subject: string | null): string | null {
  return subject !== null && hasCustomerText(subject) ? subject : null;
}

/**
 * Our label for a message with no words: one line in brackets, closed once.
 *
 * Written in the part of the regular-expression language that JavaScript and
 * Postgres read alike, because `carriesCustomerText` sends this `source` to
 * Postgres as it stands. Postgres takes `\]` and `\n` inside a bracket
 * expression as JavaScript does; what it does not share is `\s` and its kin,
 * whose meaning there is the database locale's.
 */
export const PLACEHOLDER = /^\[[^\]\n]*\]$/;

/**
 * A label wrapped round a string from elsewhere, recognised by how it opens:
 * `[edited a message: …]`, `[document: …]`, `[location: …]` or
 * `[location (…)]`, and `[unsupported message: …]` or `[unsupported message
 * type: …]`, round anything of any length and any number of lines. Each also
 * comes bare, `[document]`, when there was nothing to wrap.
 *
 * `.` under the `s` flag, because Postgres's `.` already matches a line break
 * and the flag makes JavaScript's do the same, so the pattern needs no class
 * escape for either engine to read in its own way. `source` does not carry a
 * flag, so `customer-text.test.ts` pins them — one Postgres never sees is a
 * difference between the twins.
 */
export const WRAPPED_LABEL =
  /^\[(?:edited a message|document|location|unsupported message(?: type)?)(?:(?:: | \().*)?\]$/s;

/**
 * Exactly the characters `String.prototype.trim` removes, for the query's
 * `btrim`.
 *
 * Bare `btrim` removes only the space, so a body that is nothing but a line
 * break would be blank to `hasCustomerText` and words to the query, and a
 * label after a line break would be a label to one and not the other. Naming
 * the set makes both halves trim the same characters; `customer-text.test.ts`
 * sweeps every code point to keep the list exact.
 */
export const WHITESPACE =
  '\t\n\v\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
