import { describe, expect, it } from 'vitest';
import { articleBody } from './article-write';

describe('articleBody', () => {
  it('sanitises, then normalises, and draws the text and excerpt from the result', () => {
    expect(
      articleBody(
        '<h1 class="title">Returns</h1><p style="color:red">Book a pickup.</p>' +
          '<script>alert(1)</script>',
      ),
    ).toEqual({
      bodyHtml: '<h2>Returns</h2><p>Book a pickup.</p>',
      // Capitals, because `htmlToText` formats a heading the way html-to-text
      // does by default. Pinned as it is, not endorsed: the excerpt is what the
      // help centre lists under a title and what the article page gives search
      // engines as its description.
      bodyText: 'RETURNS\n\nBook a pickup.',
      excerpt: 'RETURNS Book a pickup.',
    });
  });

  it('keeps the excerpt to 200 characters, however long the body', () => {
    const { bodyText, excerpt } = articleBody(`<p>${'word '.repeat(100)}</p>`);

    expect(bodyText.length).toBeGreaterThan(200);
    expect(excerpt).toHaveLength(200);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});
