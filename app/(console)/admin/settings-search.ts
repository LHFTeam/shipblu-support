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

/**
 * The forms a word might have had before a plural ending: "policies" may be
 * "policy", "roles" "role", "addresses" "address" and "mailboxes" "mailbox".
 * Every reading is offered rather than one chosen, since no rule short of a
 * dictionary tells "cases" (case) from "addresses" (address), and two words are
 * one when any of their readings meet. A reading shorter than three letters is
 * dropped, so "bus" is not read as "bu".
 */
function readings(word: string): string[] {
  const forms = [word];
  if (word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es')) forms.push(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1));
  return forms.filter((form) => form.length >= 3 || form === word);
}

function sameWord(a: string, b: string): boolean {
  const left = readings(a);
  return readings(b).some((form) => left.includes(form));
}

/** Whether every query word is a word, or the start of one, in `texts`. */
export function matchesQuery(words: readonly string[], texts: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = fold(texts.join(' ')).split(' ');
  return words.every((word) =>
    haystack.some((candidate) => candidate.startsWith(word) || sameWord(candidate, word)),
  );
}
