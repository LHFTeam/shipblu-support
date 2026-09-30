/**
 * Arabic letters that are one letter as far as the person writing them meant.
 *
 * Hamza forms collapse to bare alef, ya/alef-maqsura collapse, ta-marbuta
 * collapses to ha, and the two hamza-carriers collapse to their base letters.
 * These are the substitutions Egyptian colloquial writing varies on constantly,
 * and no more: the aim is a form that collapses spellings of the same word, not
 * one that makes different words equal.
 *
 * One table for the two places text is matched against what somebody typed.
 * `lib/categorise/normalise.ts` folds each variant down to its letter, because
 * it owns both sides of the comparison; a search owns only the query, so it
 * widens each letter out to the whole group instead (below). One list
 * keeps the two agreeing on which letters are one letter, and on no more than
 * that: the categoriser also strips tatweel and tashkeel from the message, and
 * a search can strip them only from the query (`cleanQuery`). So a stored
 * الشحنـة is one the categoriser files as الشحنه and a search for الشحنه does
 * not find.
 */
export const ARABIC_LETTER_VARIANTS: ReadonlyArray<{ letter: string; variants: string }> = [
  { letter: 'ا', variants: 'أإآٱ' },
  { letter: 'ي', variants: 'ىئ' },
  { letter: 'ه', variants: 'ة' },
  { letter: 'و', variants: 'ؤ' },
];

/** Every member of a group, keyed by each of them, as a bracket expression. */
const CLASS_OF = new Map<string, string>(
  ARABIC_LETTER_VARIANTS.flatMap(({ letter, variants }) => {
    const members = [letter, ...variants];
    const bracket = `[${members.join('')}]`;
    return members.map((member) => [member, bracket] as const);
  }),
);

/**
 * Everything a Postgres advanced regular expression treats as syntax outside a
 * bracket expression. A backslash before a non-alphanumeric character is that
 * character, literally, so escaping exactly these leaves every other character
 * — Arabic included — as itself.
 */
const REGEX_SYNTAX = /[\\^$.|?*+()[\]{}]/;

/**
 * A pattern for `~*` that finds the query with each Arabic letter spelled any
 * of the ways its group allows, or null when the query holds none of them.
 *
 * Why the query is widened rather than the column folded: `translate(body_text,
 * …)` is a different expression from `body_text`, so none of the trigram
 * indexes under the console's searches could serve it, and matching one would
 * take a new expression index over `messages` — which a migration builds inside
 * a transaction, blocking every write to the table while it does. pg_trgm reads a
 * regular expression's trigrams straight out of its bracket expressions, so
 * `[اأإآٱ]حمد` is served by the index that already exists. Measured against
 * production: the inbox query ran on the same plan in the same time as the ILIKE
 * it replaces, and found 8 tickets for الشحنه where the ILIKE found 4.
 *
 * Null rather than an equivalent pattern for everything else, so a query with
 * nothing to widen keeps the ILIKE it had and nothing about it changes.
 *
 * Diacritics are not bridged. Allowing one between every pair of letters would
 * leave the pattern with no fixed trigram for the index to find, and a customer
 * name or a chat message carrying tashkeel is rare enough not to be worth that.
 */
export function arabicVariantPattern(query: string): string | null {
  let widened = false;
  let out = '';

  for (const char of query) {
    const bracket = CLASS_OF.get(char);
    if (bracket) {
      widened = true;
      out += bracket;
    } else {
      out += REGEX_SYNTAX.test(char) ? `\\${char}` : char;
    }
  }

  return widened ? out : null;
}
