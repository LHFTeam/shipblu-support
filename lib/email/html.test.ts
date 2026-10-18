import { describe, expect, it } from 'vitest';
import { emailButton, escapeHtml, textToEscapedHtml } from './html';

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

describe('emailButton', () => {
  it('escapes the link and the label, and gives the bare link below the button', () => {
    const [cta, fallback] = emailButton('https://x.test/a?b=1&c="2"', 'Open <ticket>');
    expect(cta).toContain('href="https://x.test/a?b=1&amp;c=&quot;2&quot;"');
    expect(cta).toContain('>Open &lt;ticket&gt;</a>');
    expect(fallback).toContain('https://x.test/a?b=1&amp;c=&quot;2&quot;');
  });
});
