import { describe, expect, it } from 'vitest';
import { WIDGET_EMOJI } from './emoji-picker';

/**
 * The picker keys each button by its emoji and inserts the string as typed, so
 * a duplicate would be two buttons React cannot tell apart, and an entry that
 * is two graphemes would put two characters in the message for one press.
 */
describe('WIDGET_EMOJI', () => {
  it('holds each emoji once', () => {
    expect(new Set(WIDGET_EMOJI).size).toBe(WIDGET_EMOJI.length);
  });

  it('holds only single emoji, each one character as a reader sees it', () => {
    const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
    for (const emoji of WIDGET_EMOJI) {
      expect([...graphemes.segment(emoji)], emoji).toHaveLength(1);
      expect(emoji, emoji).toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
