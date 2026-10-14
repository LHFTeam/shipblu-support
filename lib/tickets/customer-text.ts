/**
 * Whether a stored message carries words somebody wrote, rather than a label we
 * wrote for it.
 *
 * A photo, a voice note or a document sent without a caption is stored with our
 * own label as its `body_text` — `[image]`, `[voice note]`, `[2 attachments]`,
 * from the `displayText` in `lib/whatsapp/parse.ts` and `lib/meta/parse.ts` — so
 * the console draws a bubble rather than a blank. The label is English and it is
 * ours, so anything that reads a customer's last words for what they say has to
 * look past it: the priority classifier would ask a model about `[image]`,
 * `requesterLocale` would answer an Arabic customer in English for sending a
 * photo of the damaged parcel, and the ticket page would open its knowledge
 * panel on a search for "image".
 *
 * A label is recognised by its shape, one line in brackets, rather than from a
 * list, so a label of the same shape added to either parser is refused without
 * anybody remembering this. The price is a customer who sends nothing but a
 * word in brackets, read as having sent no words at all.
 *
 * A WhatsApp edit is refused too, whatever it says. Its label wraps the
 * customer's new words in ours — `[edited a message: …]`, from the same
 * `displayText` — and `PLACEHOLDER` recognises that only when the words fit on
 * one line and hold no bracket. Reading the words with our wrapper still round
 * them is the worst of the answers: fourteen Latin letters outvote a short
 * Arabic correction, and a model is asked about our sentence. Unwrapping them
 * buys little, because an edit corrects a message the same person already
 * sent: the classifier asked about that message when it arrived, and a
 * correction is written in the language of what it corrects.
 *
 * Client-safe, for a page's own pick over rows it already holds. The same rule
 * for a query is `carriesCustomerText` in `lib/tickets/carries-customer-text.ts`,
 * built from the three constants below rather than spelled again, and
 * `carries-customer-text.db.test.ts` holds the two to the same answer.
 */
export function hasCustomerText(bodyText: string): boolean {
  const text = bodyText.trim();
  return text !== '' && !PLACEHOLDER.test(text) && !EDIT_LABEL.test(text);
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
 * A WhatsApp edit's label: `[edited a message]`, or `[edited a message: …]`
 * round words of any length and any number of lines.
 *
 * `.` under the `s` flag rather than `[\s\S]`, for the same reason: Postgres's
 * `.` already matches a line break, and the flag makes JavaScript's do the
 * same. `source` does not carry a flag, so `customer-text.test.ts` pins them —
 * one Postgres never sees is a difference between the twins.
 */
export const EDIT_LABEL = /^\[edited a message(?:: .*)?\]$/s;

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
