import { describe, expect, it } from 'vitest';
import { STARTER_CATEGORIES } from '@/lib/categories/registry';
import { subcategoryKeys } from '@/lib/subcategorise/taxonomy';
import { SUBCATEGORY_CATEGORY, categoryBaseline } from './baseline';

/**
 * The reviewed map from subcategory to category, held to the taxonomy so a
 * subcategory added later cannot land without a decision about which team it
 * is evidence of. The texts are the detector's own fixtures, so the rules
 * really match them.
 */

describe('SUBCATEGORY_CATEGORY', () => {
  it('decides every subcategory in the taxonomy, and nothing else', () => {
    expect(Object.keys(SUBCATEGORY_CATEGORY).sort()).toEqual([...subcategoryKeys()].sort());
  });

  it('names only starter categories', () => {
    const starters = new Set(STARTER_CATEGORIES.map((category) => category.key));
    for (const target of Object.values(SUBCATEGORY_CATEGORY)) {
      if (target !== null) expect(starters.has(target)).toBe(true);
    }
  });

  // Each class has at least one source, or the report's baseline column for it
  // is empty by construction.
  it('gives every starter category at least one subcategory', () => {
    const targets = new Set(Object.values(SUBCATEGORY_CATEGORY));
    for (const category of STARTER_CATEGORIES) expect(targets.has(category.key)).toBe(true);
  });
});

describe('categoryBaseline', () => {
  it.each([
    ['محتاجه اعرف الاسعار الاول قبل التسجيل', 'sales'],
    ['فين الشحنه', 'customer_support'],
    ['امتى التحويل الاسبوعي', 'merchant_support'],
  ])('reads %s as %s', (text, category) => {
    const baseline = categoryBaseline(text);
    expect(baseline.categoryKey).toBe(category);
    expect(baseline.subcategoryKeys.length).toBeGreaterThan(0);
  });

  // The detector's fallback survives its own filter, so a message the rules
  // cannot read shows as unclassified — which names no team.
  it('names no category for a message the rules cannot read', () => {
    const baseline = categoryBaseline('اوك تمام');
    expect(baseline.categoryKey).toBeNull();
  });
});
