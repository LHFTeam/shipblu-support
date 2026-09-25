/**
 * Canonical forms for tracking numbers and SBIDs.
 *
 * These exist for the same reason `lib/auth/normalise.ts` does: the value is
 * unique-indexed, so every path that writes or looks one up — the detector, the
 * manual link action, the search parser, the backfill, the future platform API —
 * has to agree on the canonical form or the index is unusable.
 *
 * Two of the transformations look like paranoia and are not:
 *
 * - **Arabic-Indic digits.** Roughly half the inbound volume is Arabic WhatsApp,
 *   and customers type ٠١٢٣٤٥٦٧٨٩ as readily as 0123456789. `lib/kb/language.ts`
 *   already had to reason about them for the opposite purpose.
 * - **Bidi and zero-width marks.** A number copied out of an RTL message carries
 *   a U+200F along with it. `'SB123\u200F' !== 'SB123'`, which silently defeats
 *   the unique index and produces two shipments for one parcel — the same class
 *   of bug `lib/kb/slug.ts` hit with Arabic slugs.
 */

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) → ASCII. */
export function normaliseDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (char) => {
    const code = char.codePointAt(0)!;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String((code - base) as number);
  });
}

/** Bidi controls and zero-width characters, which paste along invisibly. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * The same strip, exported, because a second module needs it.
 *
 * `lib/categorise/normalise.ts` compares message text against patterns and hits
 * the identical problem from the other direction: a U+200F pasted out of an RTL
 * message makes `الغاء` and `الغاء\u200F` different strings, so a rule that
 * should match does not. One definition rather than two regexes that will
 * eventually disagree about which controls count.
 */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/** Punctuation people put inside an identifier when writing it down. */
const SEPARATORS = /[\s\-_./\\:#]+/g;

export function normaliseTrackingNumber(value: string): string {
  return stripInvisible(normaliseDigits(value)).replace(SEPARATORS, '').trim().toUpperCase();
}

/**
 * The same, plus the SB/SBID prefix stripped.
 *
 * `SBID-4471`, `sbid 4471`, `SB4471` and a bare `4471` are one account, and an
 * agent will type whichever they saw last. Stripping the prefix here rather than
 * storing whichever form arrived first is what makes the unique index mean
 * "one row per account" instead of "one row per way of writing it".
 */
export function normaliseSbid(value: string): string {
  return normaliseTrackingNumber(value).replace(/^SB(?:ID)?/, '');
}

/**
 * Whether a normalised value could be a tracking number or an SBID at all.
 *
 * The normalisers strip the separators people write inside an identifier, not
 * everything that cannot be part of one, so a search box's `%` comes out as
 * `%`. A search that treats that as a reference either narrows to one nobody
 * holds or, inside a LIKE, matches every row. Letters and digits of any script
 * are allowed — the digits have already been folded to ASCII — because the
 * cost of a wrong refusal is only a text search in place of a reference one.
 */
export function couldBeReference(normalised: string): boolean {
  return /^[\p{L}\p{N}]+$/u.test(normalised);
}
