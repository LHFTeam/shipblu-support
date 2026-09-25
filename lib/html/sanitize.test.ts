import { describe, expect, it } from 'vitest';
import { htmlToText, textToHtml } from './sanitize';

describe('textToHtml', () => {
  it('makes a paragraph of each block separated by a blank line', () => {
    expect(textToHtml('First paragraph.\n\nSecond paragraph,\nwith a line break.')).toBe(
      '<p>First paragraph.</p>\n<p>Second paragraph,<br>with a line break.</p>',
    );
  });

  /**
   * The case every caller actually sends. A browser submits a textarea's line
   * breaks as CRLF — the HTML spec normalises them for the form data set — so an
   * agent's reply arrives as `a\r\n\r\nb`. Splitting on `\n{2,}` never matches
   * that, and every reply the console has sent went out as one paragraph glued
   * together with `<br>`s, with a stray `\r` beside each.
   */
  it('treats the CRLF a browser submits exactly like LF', () => {
    const lf = textToHtml('First paragraph.\n\nSecond paragraph,\nwith a line break.');
    expect(textToHtml('First paragraph.\r\n\r\nSecond paragraph,\r\nwith a line break.')).toBe(lf);
  });

  it('treats a line of only spaces or tabs as the blank line it looks like', () => {
    const blank = '<p>a</p>\n<p>b</p>';
    expect(textToHtml('a\r\n \r\nb')).toBe(blank);
    expect(textToHtml('a\n\t\nb')).toBe(blank);
    expect(textToHtml('a\n \t \n\n b')).toBe(blank);
  });

  it('leaves no carriage return behind for a lone CR either', () => {
    expect(textToHtml('one\rtwo')).toBe('<p>one<br>two</p>');
  });

  it('escapes what it is given, because the input is text', () => {
    expect(textToHtml("O'Brien <ops> & co")).toBe("<p>O'Brien &lt;ops&gt; &amp; co</p>");
  });
});

describe('htmlToText', () => {
  it('turns paragraphs back into blank-line-separated text without wrapping', () => {
    const long = 'word '.repeat(40).trim();
    expect(htmlToText(`<p>${long}</p><p>second</p>`)).toBe(`${long}\n\nsecond`);
  });
});
