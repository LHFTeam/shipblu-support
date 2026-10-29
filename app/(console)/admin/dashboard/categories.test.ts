import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CategoryLoad as Row } from '@/lib/reports/live';
import { CategoryLoad } from './categories';

/**
 * The open-work-by-category table: what each row links to, how a retired
 * category reads, and that an empty queue is said in words — the registry's
 * rows are always there, so the table is never short of rows to draw.
 */

const SALES = '6f1c2a40-0000-4000-8000-000000000001';
const COURIER = '6f1c2a40-0000-4000-8000-000000000002';

function render(categories: Row[]): string {
  return renderToStaticMarkup(createElement(CategoryLoad, { categories }));
}

const none = (open: number, awaitingReply = 0): Row => ({
  categoryId: null,
  labelEn: null,
  isActive: true,
  open,
  awaitingReply,
});

describe('CategoryLoad', () => {
  it('links each category to its inbox filter and leaves No category unlinked', () => {
    const html = render([
      { categoryId: SALES, labelEn: 'Sales', isActive: true, open: 2, awaitingReply: 1 },
      { categoryId: COURIER, labelEn: 'Courier jobs', isActive: false, open: 1, awaitingReply: 0 },
      none(4, 3),
    ]);

    expect(html).toContain(`href="/inbox?category=${SALES}"`);
    expect(html).toMatch(/<a [^>]*>Sales<\/a>/);
    // Drawn as anything outside its admin page draws a retired category.
    expect(html).toMatch(/<a [^>]*>Courier jobs \(retired\)<\/a>/);
    // No filter value names "no category": a link would list every ticket.
    expect(html).toMatch(/<td[^>]*>No category<\/td>/);
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it('says the queue is empty when every row is zero, rather than drawing a table of zeros', () => {
    const html = render([
      { categoryId: SALES, labelEn: 'Sales', isActive: true, open: 0, awaitingReply: 0 },
      none(0),
    ]);

    expect(html).toContain('Nothing open');
    expect(html).not.toContain('<table');
  });

  it('draws the table when only the uncategorised row holds work', () => {
    const html = render([
      { categoryId: SALES, labelEn: 'Sales', isActive: true, open: 0, awaitingReply: 0 },
      none(539, 12),
    ]);

    expect(html).toContain('<table');
    expect(html).toMatch(/<td[^>]*>539<\/td>/);
  });
});
