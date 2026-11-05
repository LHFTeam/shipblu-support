import { describe, expect, it } from 'vitest';
import { articleOutline, readingMinutes } from './outline';

describe('articleOutline', () => {
  it('gives every h2 an id and lists it, in order', () => {
    const { html, sections } = articleOutline(
      '<p>Intro</p><h2>Before you start</h2><p>a</p><h2>What happens next</h2><p>b</p>',
    );
    expect(sections).toEqual([
      { id: 'section-1', label: 'Before you start' },
      { id: 'section-2', label: 'What happens next' },
    ]);
    expect(html).toBe(
      '<p>Intro</p><h2 id="section-1">Before you start</h2><p>a</p>' +
        '<h2 id="section-2">What happens next</h2><p>b</p>',
    );
  });

  it('keeps an id the heading already has, since a link in the body may use it', () => {
    const body = '<h2 id="fees">Fees</h2><h2>Refunds</h2>';
    const { html, sections } = articleOutline(body);
    expect(sections).toEqual([
      { id: 'fees', label: 'Fees' },
      { id: 'section-1', label: 'Refunds' },
    ]);
    expect(html).toBe('<h2 id="fees">Fees</h2><h2 id="section-1">Refunds</h2>');
  });

  it('never hands out an id the body already uses, before or after the heading', () => {
    const { sections } = articleOutline(
      '<h2>One</h2><p id="section-1">anchor</p><h2 id="section-3">Two</h2><h2>Three</h2>',
    );
    expect(sections.map((s) => s.id)).toEqual(['section-2', 'section-3', 'section-4']);
  });

  it('reads the heading as text: tags dropped, entities decoded', () => {
    const { sections } = articleOutline(
      '<h2><strong>COD</strong> &amp; settlement&nbsp;dates</h2><h2>&#1575;&#1604;&#1585;&#1587;&#1608;&#1605;</h2>',
    );
    expect(sections.map((s) => s.label)).toEqual(['COD & settlement dates', 'الرسوم']);
  });

  it('skips an empty heading and returns a body without h2 unchanged', () => {
    const body = '<h3>Not a section</h3><p>Text</p><h2> </h2>';
    const { html, sections } = articleOutline(body);
    expect(sections).toEqual([]);
    expect(html).toBe(body);
  });

  it('works in Arabic', () => {
    const { sections } = articleOutline('<h2>قبل البدء</h2><h2>ما يحدث بعد ذلك</h2>');
    expect(sections.map((s) => s.label)).toEqual(['قبل البدء', 'ما يحدث بعد ذلك']);
  });
});

describe('readingMinutes', () => {
  it('never says zero', () => {
    expect(readingMinutes('')).toBe(1);
    expect(readingMinutes('<p>Short.</p>')).toBe(1);
  });

  it('counts words in either language at two hundred a minute', () => {
    const english = `<p>${'word '.repeat(800)}</p>`;
    const arabic = `<p>${'كلمة '.repeat(800)}</p>`;
    expect(readingMinutes(english)).toBe(4);
    expect(readingMinutes(arabic)).toBe(4);
  });

  it('counts a screenshot as a few seconds of reading', () => {
    const body = `<p>${'word '.repeat(200)}</p>${'<img src="a.png">'.repeat(12)}`;
    expect(readingMinutes(body)).toBe(3);
  });
});
