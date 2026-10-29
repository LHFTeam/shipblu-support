/**
 * How the settings home's search decides that an entry answers a query.
 *
 * Word by word rather than as a substring of the whole entry. Substrings let
 * "ai" find Groups through "reclaim" and Channels through "email", and they
 * could not see that "policy" is the word in "SLA policies" or "roles" the one
 * in "role" — which are exactly the names somebody arriving from Zendesk or
 * Freshdesk types. So each word typed must begin a word of the entry, or be the
 * same word once a plural ending is taken off both, and the little words of a
 * phrase ("roles and permissions") are not asked for at all.
 *
 * A plain module, not the client component that uses it, so a test can hold
 * the examples the page promises to their answers.
 */

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

/** Lower case, and punctuation as spaces, so "auto-reply" finds "auto reply". */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of a query that have to be found. None means "show everything". */
export function queryWords(query: string): string[] {
  return fold(query)
    .split(' ')
    .filter((word) => word !== '' && !STOP_WORDS.has(word));
}

/** "policies" and "policy", "roles" and "role": one word for matching. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Whether every query word is a word, or the start of one, in `texts`. */
export function matchesQuery(words: readonly string[], texts: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = fold(texts.join(' ')).split(' ');
  return words.every((word) =>
    haystack.some(
      (candidate) => candidate.startsWith(word) || singular(candidate) === singular(word),
    ),
  );
}
