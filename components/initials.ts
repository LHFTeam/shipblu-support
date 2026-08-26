/**
 * Zero-width and bidi formatting characters.
 *
 * `\s` matches none of them, so without stripping them a name carrying one keeps
 * it as its "first letter" and the tile renders blank. Not a contrived input
 * here: an RLM or LRM prefix rides along routinely on an Arabic name pasted out
 * of WhatsApp or Instagram, and Arabic is this product's default locale — so the
 * invisible-initial case is a first render for a real customer.
 *
 * U+200B–U+200F are the zero-width and directional marks, U+202A–U+202E the
 * legacy embedding and override controls, U+2066–U+2069 the isolate controls
 * that replaced them, and U+FEFF a byte-order mark that survived a bad decode.
 * All four ranges, because a name pasted from one app carries whichever pair
 * that app emits — and the two halves of a pair sit in different ranges.
 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Up to two initials, from the first and last word of a name.
 *
 * Split out of `Avatar` so it can be tested without a DOM — the cases that
 * break it are all about what a name is made of, and this codebase's names come
 * from Instagram display names and Arabic contact records rather than from a
 * form with a validator on it.
 */
export function initials(name: string | null): string {
  const words = (name ?? '').replace(INVISIBLE, '').trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return '?';

  const first = firstLetter(words[0]!);
  const last = words.length > 1 ? firstLetter(words[words.length - 1]!) : '';

  return first + last;
}

/**
 * The first letter of a word, upper-cased, as exactly one glyph.
 *
 * Two ways that goes wrong if written the obvious way. `word[0]` takes half a
 * surrogate pair from a name starting with an emoji and renders a replacement
 * glyph — routine in Instagram display names. And `toUpperCase()` is not
 * length-preserving: German ß becomes SS, so "ßeta gamma" would put three
 * characters in a two-character tile. Uppercasing first and then taking one code
 * point handles both.
 *
 * Caseless scripts are unaffected — Arabic simply keeps its letter, and the
 * surrounding `direction()` rules order it.
 */
function firstLetter(word: string): string {
  return Array.from(word.toUpperCase())[0] ?? '';
}
