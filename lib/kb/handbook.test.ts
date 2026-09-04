import { describe, expect, it } from 'vitest';
import { ROLES_BY_SENIORITY, roleSeniority } from '@/lib/auth/permissions';
import { htmlToText, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from './format';
import { HANDBOOK, HANDBOOK_CATEGORY } from './handbook';
import { slugify } from './slug';

/**
 * What a test can hold this content to.
 *
 * Not whether an article is well written — that is review's job. These pin the
 * three things that would ship broken and stay broken: a body the write path
 * would rewrite (so the seeding job would never settle and every run would cut
 * a version row), a key or slug that collides (so one article silently
 * overwrites another), and a folder whose audience is wider than intended.
 */

const articles = HANDBOOK.flatMap((folder) =>
  folder.articles.map((article) => ({ folder, article })),
);

describe('the handbook’s shape', () => {
  it('has a unique key and slug for every article', () => {
    const keys = articles.map(({ article }) => article.key);
    const slugs = articles.map(({ article }) => article.slug);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('has a unique key and slug for every folder', () => {
    // A duplicated folder key is not a loud failure: `(source_system,
    // external_id)` is unique, so the second `upsertFolder` finds the first
    // folder's row, overwrites its floor with the second's and hands both sets
    // of articles the same id — three admin articles filed under a supervisor
    // floor, with the tally still reporting five folders.
    const keys = HANDBOOK.map((folder) => folder.key);
    const slugs = HANDBOOK.map((folder) => folder.slug);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses slugs that survive slugify unchanged', () => {
    // The seeding job re-finds a row by its slug. One that slugify would
    // rewrite is a key that stops matching the moment anything re-derives it.
    for (const { article } of articles) expect(slugify(article.slug)).toBe(article.slug);
    for (const folder of HANDBOOK) expect(slugify(folder.slug)).toBe(folder.slug);
    expect(slugify(HANDBOOK_CATEGORY.slug)).toBe(HANDBOOK_CATEGORY.slug);
  });

  it('covers the whole ladder, most junior folder first', () => {
    // Not decoration: the folders are the audiences this handbook exists to
    // separate, and one missing means a role with nothing addressed to it.
    expect(HANDBOOK.map((folder) => folder.minRole)).toEqual([
      'agent',
      'agent',
      'supervisor',
      'admin',
      'account_admin',
    ]);
    expect(new Set(HANDBOOK.map((folder) => folder.minRole))).toEqual(new Set(ROLES_BY_SENIORITY));

    const floors = HANDBOOK.map((folder) => roleSeniority(folder.minRole));
    expect(floors).toEqual([...floors].sort((a, b) => a - b));
  });

  it('gives every folder and article something to read', () => {
    for (const folder of HANDBOOK) {
      expect(folder.name.trim()).not.toBe('');
      expect(folder.description.trim()).not.toBe('');
      expect(folder.articles.length).toBeGreaterThan(0);
    }
    for (const { article } of articles) {
      expect(article.title.trim()).not.toBe('');
      // Long enough to be an article rather than a heading with a sentence
      // under it — the shape the four imported placeholders already have.
      expect(htmlToText(article.bodyHtml).length).toBeGreaterThan(600);
    }
  });
});

describe('the handbook’s formatting', () => {
  it.each(articles.map(({ article }) => [article.slug, article] as const))(
    '%s is already what the write path would store',
    (_slug, article) => {
      // Sanitise then normalise, in that order, exactly as `saveArticle` and
      // the seeding job do. A body that is not a fixed point of this means the
      // job rewrites it on the first run and cuts a version row on a second.
      expect(normaliseArticleHtml(sanitiseArticleHtml(article.bodyHtml))).toBe(article.bodyHtml);
    },
  );

  it('carries no body h1, class, style or dir', () => {
    // The four rules from `format.ts` most likely to arrive with a paste. The
    // fixed-point test above already implies these; they are named separately
    // so a failure says which rule was broken rather than printing two
    // near-identical kilobytes of HTML.
    for (const { article } of articles) {
      expect(article.bodyHtml).not.toMatch(/<h1\b/i);
      expect(article.bodyHtml).not.toMatch(/\b(?:class|style|dir)=/i);
      expect(article.bodyHtml).not.toMatch(/<\/?(?:div|span)\b/i);
    }
  });
});
