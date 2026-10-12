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
 * Tab takes it only once it has been in front of the agent for a moment. The
 * ghost appears in an empty box the moment the box takes focus — before any
 * typing, unlike an editor's completion — which is exactly when somebody using
 * the keyboard is passing through on the way to the picker, the knowledge
 * panel or Send. Without the wait, Tab-Tab through the composer inserted a
 * canned response nobody chose and wrote it to the report as taken, and the
 * only ways past without that were Esc, which writes a dismissal instead, or
 * going back. A Tab inside the wait is left to the browser, so passing through
 * moves focus and records nothing, and the ghost is still there to take.
 * Escape is not held back: nobody presses it on the way past.
 *
 * The caller decides whether there is anything to take, and how long it has
 * been on screen in the focused box; this only reads the key.
 */

/**
 * How long a suggestion must have been on screen, in the focused box, before
 * Tab takes it. Long enough to cover a keyboard user's Tab-Tab through a form
 * (a few hundred milliseconds apiece) and short enough that somebody who has
 * read the grey text is not kept waiting; a Tab inside it moves focus, and the
 * agent can come back and take the suggestion.
 */
export const TAB_TAKES_AFTER_MS = 500;

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

export function suggestionKey(event: KeyLike, seenForMs: number): SuggestionKey {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === 'Tab') return seenForMs >= TAB_TAKES_AFTER_MS ? 'accept' : null;
  if (event.key === 'Escape') return 'dismiss';
  return null;
}
