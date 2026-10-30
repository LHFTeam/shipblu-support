import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from './sections';
import { matchesQuery, queryWords } from './settings-search';

/**
 * The search answers in somebody else's vocabulary, so what is pinned here is
 * the vocabulary: what an admin used to Zendesk, Freshdesk or Intercom types,
 * run over the real map, and the page it must lead to. The page's placeholder
 * and header comment promise the first few; the rest are the misses a review of
 * the first version found.
 */

function search(query: string): string[] {
  const words = queryWords(query);
  return ADMIN_SECTIONS.flatMap((section) =>
    section.pages
      .filter((page) =>
        matchesQuery(words, [section.title, page.label, page.description, ...page.keywords]),
      )
      .map((page) => page.href),
  );
}

describe('settings search', () => {
  it.each([
    ['macros', '/admin/canned'],
    ['office hours', '/admin/hours'],
    ['WhatsApp', '/admin/channels'],
    ['out of office', '/admin/auto-responses'],
    ['after hours', '/admin/auto-responses'],
    ['triggers', '/admin/automations'],
    ['sla policy', '/admin/sla'],
    ['roles and permissions', '/admin/agents'],
    ['ticket types', '/admin/categories'],
    ['load balancing', '/admin/groups'],
    ['round robin', '/admin/groups'],
    ['csat', '/admin/csat'],
    ['holidays', '/admin/hours'],
    ['message templates', '/admin/channels'],
    ['freshdesk', '/admin/import'],
    ['review queue', '/admin/subcategories'],
    ['email addresses', '/admin/channels'],
    ['mailboxes', '/admin/channels'],
    ['statuses', '/admin/statuses'],
  ])('leads "%s" to %s', (query, href) => {
    expect(search(query)).toContain(href);
  });

  it('narrows as words are added', () => {
    expect(search('sla hours')).toEqual(['/admin/hours']);
  });

  it('matches whole words from their start, not letters inside them', () => {
    // "ai" is inside "email" and "reclaim"; neither is a reason to offer
    // Channels or Groups to somebody looking for the AI settings.
    expect(search('ai')).toEqual(['/admin/ai']);
  });

  it('reads a query of nothing but small words as no query', () => {
    expect(queryWords('and the')).toEqual([]);
    expect(matchesQuery([], ['anything'])).toBe(true);
  });

  it('folds punctuation and case', () => {
    expect(search('Auto-Reply')).toContain('/admin/auto-responses');
  });

  it('finds nothing for a word no entry has', () => {
    expect(search('zzz')).toEqual([]);
  });
});
