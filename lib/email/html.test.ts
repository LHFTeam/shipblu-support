import { describe, expect, it } from 'vitest';
import { escapeHtml, textToEscapedHtml } from './html';

describe('textToEscapedHtml', () => {
  it('escapes markup once, ampersand first', () => {
    expect(textToEscapedHtml('<b>"A & B"</b>')).toBe('&lt;b&gt;&quot;A &amp; B&quot;&lt;/b&gt;');
    expect(textToEscapedHtml('&lt;')).toBe('&amp;lt;');
  });

  // The two ways it differs from escapeHtml, which are why it has its own name.
  it('keeps a line break, which escapeHtml would let collapse', () => {
    expect(textToEscapedHtml('one\ntwo')).toBe('one<br>two');
    expect(escapeHtml('one\ntwo')).toBe('one\ntwo');
  });

  it('leaves an apostrophe alone, which escapeHtml escapes for an attribute', () => {
    expect(textToEscapedHtml("can't")).toBe("can't");
    expect(escapeHtml("can't")).toBe('can&#39;t');
  });
});
