import { describe, expect, it } from 'vitest';
import { insertCanned } from './canned';

describe('insertCanned', () => {
  it('fills an empty box without leading blank lines', () => {
    const { text, caret } = insertCanned('', 'Thanks for getting in touch.', 0, 0);

    expect(text).toBe('Thanks for getting in touch.');
    expect(caret).toBe(text.length);
  });

  it('inserts at the caret rather than appending', () => {
    // The case that actually happens: a sentence of their own, then the
    // boilerplate, then their sign-off. Appending would put it after the sign-off.
    const current = 'Hi Sara,\n\nBest,\nAli';
    const { text } = insertCanned(current, 'Your parcel is on its way.', 10, 10);

    expect(text).toBe('Hi Sara,\n\nYour parcel is on its way.\n\nBest,\nAli');
  });

  it('leaves the caret after what it inserted', () => {
    const { text, caret } = insertCanned('Hi.', 'Boilerplate.', 3, 3);

    expect(text).toBe('Hi.\n\nBoilerplate.');
    expect(caret).toBe(text.length);
    expect(text.slice(0, caret).endsWith('Boilerplate.')).toBe(true);
  });

  it('replaces a selection', () => {
    // "REPLACE ME" spans 5..15 between two paragraph breaks, so the breaks are
    // already there and none are added.
    const { text } = insertCanned('Hi.\n\nREPLACE ME\n\nBye.', 'Snippet.', 5, 15);
    expect(text).toBe('Hi.\n\nSnippet.\n\nBye.');
  });

  it('keeps whatever sits either side of the selection, spaces included', () => {
    const { text } = insertCanned('Hi. REPLACE ME Bye.', 'Snippet.', 4, 14);
    expect(text).toBe('Hi. \n\nSnippet.\n\n Bye.');
  });

  it('does not stack blank lines that are already there', () => {
    // Pasting against an existing paragraph break must not open a third line.
    const { text } = insertCanned('Hi.\n\n', 'Snippet.', 5, 5);
    expect(text).toBe('Hi.\n\nSnippet.');
  });

  it('completes a single newline into a paragraph break', () => {
    const { text } = insertCanned('Hi.\n', 'Snippet.', 4, 4);
    expect(text).toBe('Hi.\n\nSnippet.');
  });

  it('is a no-op for a response whose body is blank', () => {
    expect(insertCanned('Hi.', '   \n  ', 3, 3)).toEqual({ text: 'Hi.', caret: 3 });
  });

  it('trims the stored body rather than importing its trailing newlines', () => {
    const { text } = insertCanned('', '\n\nThanks.\n\n', 0, 0);
    expect(text).toBe('Thanks.');
  });

  it('clamps a caret the textarea and the model disagree about', () => {
    // Defensive: a caret past the end would otherwise slice a string neither
    // side expects and silently duplicate the tail.
    const { text } = insertCanned('Hi.', 'Snippet.', 99, 99);
    expect(text).toBe('Hi.\n\nSnippet.');

    const backwards = insertCanned('Hi there.', 'Snippet.', 5, 2);
    expect(backwards.text).toBe('Hi th\n\nSnippet.\n\nere.');
  });
});
