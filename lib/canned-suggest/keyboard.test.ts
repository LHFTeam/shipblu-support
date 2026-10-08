import { describe, expect, it } from 'vitest';
import { suggestionKey, type KeyLike } from './keyboard';

const plain: KeyLike = {
  key: 'Tab',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

describe('suggestionKey', () => {
  it('takes a suggestion on a bare Tab and waves it away on Escape', () => {
    expect(suggestionKey(plain)).toBe('accept');
    expect(suggestionKey({ ...plain, key: 'Escape' })).toBe('dismiss');
  });

  // Shift+Tab is "go back a field"; the others belong to the browser and the OS.
  it('leaves Tab with any modifier alone', () => {
    for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) {
      expect(suggestionKey({ ...plain, [modifier]: true })).toBeNull();
    }
  });

  // An input method uses both keys inside a composition; taking either would
  // put a canned response into the middle of a word still being spelt.
  it('does nothing while an input method is composing', () => {
    expect(suggestionKey({ ...plain, isComposing: true })).toBeNull();
    expect(suggestionKey({ ...plain, key: 'Escape', keyCode: 229 })).toBeNull();
  });

  it('ignores every other key', () => {
    expect(suggestionKey({ ...plain, key: 'Enter' })).toBeNull();
    expect(suggestionKey({ ...plain, key: 'a' })).toBeNull();
  });
});
