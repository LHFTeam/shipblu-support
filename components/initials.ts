/**
 * Up to two initials, from the first and last word of a name.
 *
 * Split out of `Avatar` so it can be tested without a DOM — the cases that
 * break it are all about what a name is made of, and this codebase's names come
 * from Instagram display names and Arabic contact records rather than from a
 * form with a validator on it.
 */
export function initials(name: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';

  // `Array.from` rather than `[0]`, because a name starting with an emoji or any
  // other astral-plane character has a surrogate pair there: indexing takes half
  // of it and renders a replacement glyph. Instagram display names contain both
  // routinely.
  const first = Array.from(words[0]!)[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1]!)[0] ?? '') : '';

  // `toUpperCase` is a no-op for Arabic, which is caseless — the initial is
  // simply the letter, and the surrounding `direction()` rules order it.
  return (first + last).toUpperCase();
}
