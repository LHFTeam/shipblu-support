import { describe, expect, it } from 'vitest';
import { TAB_TAKES_AFTER_MS, suggestionKey, type KeyLike } from './keyboard';

const plain: KeyLike = {
  key: 'Tab',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

/** Long enough on screen that a bare Tab means the agent read it. */
const READ = TAB_TAKES_AFTER_MS;

describe('suggestionKey', () => {
  it('takes a suggestion on a bare Tab and waves it away on Escape', () => {
    expect(suggestionKey(plain, READ)).toBe('accept');
    expect(suggestionKey({ ...plain, key: 'Escape' }, READ)).toBe('dismiss');
  });

  // Shift+Tab is "go back a field"; the others belong to the browser and the OS.
  it('leaves Tab with any modifier alone', () => {
    for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(suggestionKey({ ...plain, [modifier]: true }, READ)).toBeNull();
    }
  });

  // An input method uses both keys inside a composition; taking either would
  // put a canned response into the middle of a word still being spelt.
  it('does nothing while an input method is composing', () => {
    expect(suggestionKey({ ...plain, isComposing: true }, READ)).toBeNull();
    expect(suggestionKey({ ...plain, key: 'Escape', keyCode: 229 }, READ)).toBeNull();
  });

  it('ignores every other key', () => {
    expect(suggestionKey({ ...plain, key: 'Enter' }, READ)).toBeNull();
    expect(suggestionKey({ ...plain, key: 'a' }, READ)).toBeNull();
  });

  // The ghost is in the box the moment it takes focus, so a keyboard user's
  // Tab-Tab through the composer reaches it before anybody has read it. That
  // Tab must move focus and record nothing, not insert a reply and count it.
  it('leaves a Tab to the browser until the suggestion has been on screen for a moment', () => {
    expect(suggestionKey(plain, 0)).toBeNull();
    expect(suggestionKey(plain, TAB_TAKES_AFTER_MS - 1)).toBeNull();
    expect(suggestionKey(plain, TAB_TAKES_AFTER_MS)).toBe('accept');
  });

  // Nobody presses Escape on the way past, so it is never held back.
  it('dismisses on Escape however briefly the suggestion has been there', () => {
    expect(suggestionKey({ ...plain, key: 'Escape' }, 0)).toBe('dismiss');
  });
});
