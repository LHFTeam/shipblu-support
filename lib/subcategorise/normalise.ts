import { stripTashkeel } from '@/lib/kb/seed';
import { ARABIC_LETTER_VARIANTS } from '@/lib/search/arabic';
import { normaliseDigits, stripInvisible } from '@/lib/shipments/format';

/**
 * Putting a message and a pattern into the same shape so they can be compared.
 *
 * ## Why this folds Arabic letters when `lib/kb/seed.ts` deliberately does not
 *
 * That file's comment is explicit: it does *not* fold أ إ آ to ا, ى to ي or ة to
 * ه, because it compares extracted terms against a Postgres tsvector built with
 * the `simple` configuration, which folds nothing. Folding one side of a
 * comparison and not the other turns a match into a miss.
 *
 * **This module owns both sides.** The haystack is the customer's message and
 * the needle is a pattern we wrote, and both go through here. So folding is free,
 * and the archive shows it is necessary rather than tidy: `إلغاء الشحنه`,
 * `الغاء الشحنة`, `الغاء الشحنه`, `الغي` and `الغى` all appear, all mean cancel
 * this shipment, and without folding each spelling needs its own rule — which is
 * how a lexicon rots, because the next spelling nobody thought of silently
 * matches nothing.
 *
 * ## Order is load-bearing
 *
 * Diacritics come off before anything tokenises, for the reason `lib/kb/seed.ts`
 * documents: a diacritic is not a letter, so a split on non-letters tears
 * الشِّحنة into two fragments. Digits fold before matching, or an Arabic
 * message's numbers are invisible to a pattern written with `\d`.
 */

/**
 * Arabic orthographic variants folded to the one letter they stand for. The
 * list is `ARABIC_LETTER_VARIANTS`, shared with the inbox search so a spelling
 * this recognises is one an agent can also find.
 */
const FOLD: ReadonlyArray<readonly [RegExp, string]> = ARABIC_LETTER_VARIANTS.map(
  ({ letter, variants }) => [new RegExp(`[${variants}]`, 'g'), letter] as const,
);

/** Arabic punctuation that has an ASCII twin people use interchangeably. */
const PUNCTUATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/؟/g, '?'], // ؟
  [/،/g, ','], // ،
  [/؛/g, ';'], // ؛
];

/**
 * How much of a message is looked at.
 *
 * A forwarded email thread or a pasted spreadsheet is not a support topic, and
 * scanning all of it costs precision rather than buying recall: the further in
 * you read, the more likely a keyword belongs to somebody else's sentence.
 * `lib/kb/language.ts` samples 2,000 characters for the same class of reason.
 */
export const MAX_TEXT_LENGTH = 4000;

/**
 * The canonical form both sides of every comparison are put into.
 *
 * Idempotent, and there is a test that says so over the whole button vocabulary:
 * an admin-supplied phrase is stored already normalised, so if running this
 * twice changed the answer, a stored phrase would be unmatchable.
 */
export function normaliseForMatch(text: string): string {
  let out = text.slice(0, MAX_TEXT_LENGTH).normalize('NFKC');

  out = normaliseDigits(out);
  out = stripInvisible(out);
  out = out.toLowerCase();
  out = stripTashkeel(out);

  for (const [pattern, replacement] of FOLD) out = out.replace(pattern, replacement);
  for (const [pattern, replacement] of PUNCTUATION) out = out.replace(pattern, replacement);

  // A run of one punctuation mark is one gesture, not six. `؟؟؟؟؟؟` and `؟` are
  // the same message — somebody with no answer — and collapsing them means one
  // rule matches both instead of a rule per length.
  out = out.replace(/([!?.,;])\1+/g, '$1');
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}

/**
 * A pattern that only matches at a token boundary, in either script.
 *
 * **`\b` is unusable here and quietly so.** It is defined in terms of `\w`,
 * which is ASCII, so between two Arabic letters there is no boundary at all: a
 * naive `/لا/` ("no") matches inside `الغاء` (cancel), `اهلا` (hello) and `ولا`
 * (nor) — and the archive contains `انا مش متواجدة غدا الخميس ولا الجمعة`, a
 * reschedule request that a `لا` rule would file as a refusal.
 *
 * Unicode property lookarounds are the fix. Every rule is built through this
 * function so no pattern can be written without them.
 */
export function anchored(body: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu');
}

/**
 * Whether a normalised message has enough in it to be worth matching.
 *
 * Three alphanumerics, the same floor `lib/kb/seed.ts` puts on a search term.
 * Below it a message is a greeting, a punctuation mark or an emoji, and the
 * honest answer is that there is nothing to classify rather than a guess from
 * two characters.
 */
export function hasEnoughContent(normalised: string): boolean {
  let count = 0;
  for (const char of normalised) {
    if (/[\p{L}\p{N}]/u.test(char)) count += 1;
    if (count >= 3) return true;
  }
  return false;
}
