import { describe, expect, it } from 'vitest';
import { detectLocale } from '@/lib/kb/language';
import {
  ROOT_CAUSES,
  TAXONOMY,
  UNCLASSIFIED_KEY,
  allCategories,
  areaOf,
  categoryKeys,
  rootCauseKeys,
} from './taxonomy';

/**
 * Structural guards on the taxonomy.
 *
 * None of this tests matching — that is `detect.test.ts`. These are the
 * invariants the database and the seed both assume, checked here because a
 * violation is a failed migration or a silently unassignable category, and both
 * are much cheaper to find in the pre-push loop than in the `database` CI job.
 */

describe('category keys', () => {
  it('are unique', () => {
    const keys = categoryKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('match the shape the CHECK constraint enforces', () => {
    for (const key of categoryKeys()) {
      expect(key, `${key} must be area.slug, lowercase`).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('carry an area equal to the part before the dot', () => {
    // The `area` column exists so reports can group without split_part; this is
    // what stops the two drifting, and it mirrors the CHECK in db/sql.
    for (const category of allCategories()) {
      expect(areaOf(category.key)).toBe(category.area);
    }
  });

  it('declare the area they are nested under', () => {
    for (const area of TAXONOMY) {
      for (const category of area.categories) {
        expect(areaOf(category.key), `${category.key} is nested under ${area.area}`).toBe(
          area.area,
        );
      }
    }
  });
});

describe('root cause keys', () => {
  it('are unique', () => {
    const keys = rootCauseKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('match the shape the CHECK constraint enforces', () => {
    for (const key of rootCauseKeys()) {
      expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('name their owner in the key', () => {
    // The prefix *is* the owner, so a mis-filed cause is visible by reading it
    // rather than only by joining. This is the check that keeps that true.
    for (const cause of ROOT_CAUSES) {
      expect(areaOf(cause.key), `${cause.key} should be prefixed with its owner`).toBe(cause.owner);
    }
  });

  it('covers every owner the enum allows', () => {
    // An owner with no causes is an owner nothing can ever be attributed to,
    // which reads on a report as "this team never causes tickets".
    const owners = new Set(ROOT_CAUSES.map((c) => c.owner));
    for (const owner of [
      'courier',
      'hub',
      'merchant',
      'recipient',
      'platform',
      'external',
      'none',
    ]) {
      expect(
        owners.has(owner as (typeof ROOT_CAUSES)[number]['owner']),
        `no cause for ${owner}`,
      ).toBe(true);
    }
  });
});

describe('labels', () => {
  it('are present in both languages', () => {
    for (const category of allCategories()) {
      expect(category.labelEn.trim().length, category.key).toBeGreaterThan(0);
      expect(category.labelAr.trim().length, category.key).toBeGreaterThan(0);
    }
    for (const cause of ROOT_CAUSES) {
      expect(cause.labelEn.trim().length, cause.key).toBeGreaterThan(0);
      expect(cause.labelAr.trim().length, cause.key).toBeGreaterThan(0);
    }
  });

  it('has actual Arabic in every Arabic label', () => {
    // The one error nobody reviewing an English diff will notice: an English
    // placeholder left in labelAr. Arabic is the default locale and these labels
    // are what a report is read in, so a missing translation is a broken report
    // rather than a cosmetic gap.
    for (const category of allCategories()) {
      expect(detectLocale(category.labelAr), `${category.key} labelAr is not Arabic`).toBe('ar');
    }
    for (const cause of ROOT_CAUSES) {
      expect(detectLocale(cause.labelAr), `${cause.key} labelAr is not Arabic`).toBe('ar');
    }
  });

  it('has no Arabic in an English label', () => {
    for (const category of allCategories()) {
      expect(detectLocale(category.labelEn), `${category.key} labelEn is not English`).toBe('en');
    }
  });
});

describe('the shape of the taxonomy', () => {
  it('stays inside the range a person can actually choose from', () => {
    // Best practice puts a usable taxonomy in the tens, not the hundreds: past
    // that agents pick the first plausible row and the numbers stop meaning
    // anything. This is the guard against it quietly growing to 200.
    expect(categoryKeys().length).toBeGreaterThanOrEqual(15);
    expect(categoryKeys().length).toBeLessThanOrEqual(60);
  });

  it('has no empty area', () => {
    for (const area of TAXONOMY) {
      expect(area.categories.length, `${area.area} has no categories`).toBeGreaterThan(0);
    }
  });

  it('gives every area both labels', () => {
    for (const area of TAXONOMY) {
      expect(area.labelEn.trim().length).toBeGreaterThan(0);
      expect(detectLocale(area.labelAr), `${area.area} labelAr is not Arabic`).toBe('ar');
    }
  });

  it('assigns a stable, gapless position', () => {
    // The picker's order and the last tie-break for the primary category both
    // read this, so a duplicate would make the primary depend on row order.
    const positions = allCategories().map((c) => c.position);
    expect(positions).toEqual(positions.map((_, i) => i));
  });

  it('includes the unclassified fallback', () => {
    expect(categoryKeys()).toContain(UNCLASSIFIED_KEY);
  });
});
