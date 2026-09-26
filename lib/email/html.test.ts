import { describe, expect, it } from 'vitest';
import { escapeHtml, textToEscapedHtml } from './html';

describe('textToEscapedHtml', () => {
  it('escapes markup once, ampersand first', () => {
    expect(textToEscapedHtml('<b>"A & B"</b>')).toBe('&lt;b&gt;&quot;A &amp; B&quot;&lt;/b&gt;');
    expect(textToEscapedHtml('&lt;')).toBe('&amp;lt;');
  });

  // The one way it differs from escapeHtml, which is why it has its own name.
  it('keeps a line break, which escapeHtml would let collapse', () => {
    expect(textToEscapedHtml('one\ntwo')).toBe('one<br>two');
    expect(escapeHtml('one\ntwo')).toBe('one\ntwo');
  });

  it('escapes an apostrophe as escapeHtml does, which renders the same in text', () => {
    expect(textToEscapedHtml("can't")).toBe('can&#39;t');
  });
});
