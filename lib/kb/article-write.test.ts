import { describe, expect, it } from 'vitest';
import { articleBody, changesNothing } from './article-write';

describe('articleBody', () => {
  it('sanitises, then normalises, and draws the text and excerpt from the result', () => {
    expect(
      articleBody(
        '<h1 class="title">Returns</h1><p style="color:red">Book a pickup.</p>' +
          '<script>alert(1)</script>',
      ),
    ).toEqual({
      bodyHtml: '<h2>Returns</h2><p>Book a pickup.</p>',
      // The heading in its own case: the excerpt is what the help centre lists
      // under a title and what search engines are given as the description.
      bodyText: 'Returns\n\nBook a pickup.',
      excerpt: 'Returns Book a pickup.',
    });
  });

  it('keeps the excerpt to 200 characters, however long the body', () => {
    const { bodyText, excerpt } = articleBody(`<p>${'word '.repeat(100)}</p>`);

    expect(bodyText.length).toBeGreaterThan(200);
    expect(excerpt).toHaveLength(200);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('changesNothing', () => {
  const stored = {
    title: 'Pickups',
    tags: ['courier', 'pickup'],
    seo: { title: 'Pickups', description: 'Book one' },
    minRole: null,
    updatedAt: new Date('2026-03-01T09:00:00Z'),
  };

  it('is true when every column written holds what is stored', () => {
    expect(
      changesNothing(stored, {
        title: 'Pickups',
        tags: ['courier', 'pickup'],
        // jsonb keeps no key order, so neither does the comparison.
        seo: { description: 'Book one', title: 'Pickups' },
        minRole: null,
      }),
    ).toBe(true);
  });

  it("ignores the writer's own stamp, and a column it leaves out of the SET", () => {
    expect(
      changesNothing(stored, { title: 'Pickups', updatedAt: new Date(), minRole: undefined }),
    ).toBe(true);
  });

  it.each([
    ['a different title', { title: 'Booking a pickup' }],
    ['the tags in another order', { tags: ['pickup', 'courier'] }],
    ['one tag fewer', { tags: ['courier'] }],
    ['an SEO field cleared', { seo: { title: 'Pickups' } }],
    ['a floor set', { minRole: 'supervisor' }],
    ['a column the row does not hold', { externalId: 'freshdesk:1' }],
  ])('is false for %s', (_label, next) => {
    expect(changesNothing(stored, next)).toBe(false);
  });
});
