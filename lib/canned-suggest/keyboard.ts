/**
 * Which key takes or waves away a suggestion in the reply box.
 *
 * Imports nothing, because the composer is a client component and the
 * `client-bundle` rule walks every value import out of it: this file has to be
 * safe to ship to the browser, and it is pure so the rule is tested rather than
 * read.
 *
 * Tab with no modifier takes it — Shift+Tab is "go back a field", and Ctrl/Alt/
 * Meta+Tab belong to the browser and the operating system. Escape waves it away.
 *
 * Nothing while an input method is composing. Arabic keyboards on some systems,
 * and every IME for the languages agents type in, use Tab and Escape inside a
 * composition; taking either there would insert a canned response into the
 * middle of a word somebody was still spelling. `keyCode` 229 is the browser's
 * own marker for a key event that belongs to a composition, kept beside
 * `isComposing` because Safari reports it on the keydown that ends one — the
 * same guard `components/search-input.tsx` uses for Enter.
 *
 * The caller decides whether there is anything to take; this only reads the key.
 */

export type SuggestionKey = 'accept' | 'dismiss' | null;

export type KeyLike = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export function suggestionKey(event: KeyLike): SuggestionKey {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === 'Tab') return 'accept';
  if (event.key === 'Escape') return 'dismiss';
  return null;
}
