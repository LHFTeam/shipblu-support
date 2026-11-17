import { describe, expect, it } from 'vitest';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import { TrackingNumber } from './schemas';
import { storedTrackingFold } from './tracking-fold';

/**
 * The list's filter folds the stored number with `trackingFoldSql` and the
 * asked one with `normaliseTrackingNumber`. They agree only on what
 * `TrackingNumber` admits, so the test holds both halves of that.
 */
describe('the tracking-number fold', () => {
  const admitted = [
    'SB-AB12',
    'sb-ab12',
    'Sb-aB-1-2',
    '1755021358719',
    '-',
    'a',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-0123456789',
  ];

  it('folds every number the schema admits as the normaliser does', () => {
    for (const value of admitted) {
      expect(TrackingNumber.safeParse(value).success).toBe(true);
      expect(storedTrackingFold(value)).toBe(normaliseTrackingNumber(value));
    }
  });

  // Each is something the normaliser strips or folds beyond case and a
  // hyphen. Admitted by the schema, the stored side would keep it and the
  // asked side drop it, and the filter would find nothing.
  it.each([
    ['a space', 'SB AB12'],
    ['a tab', 'SB\tAB12'],
    ['an underscore', 'SB_AB12'],
    ['a dot', 'SB.AB12'],
    ['a slash', 'SB/AB12'],
    ['a backslash', 'SB\\AB12'],
    ['a colon', 'SB:AB12'],
    ['a hash', 'SB#AB12'],
    ['a right-to-left mark', 'SB‏AB12'],
    ['a zero-width space', 'SB​AB12'],
    ['a byte-order mark', '﻿SBAB12'],
    ['an Arabic-Indic digit', 'SBAB١٢'],
    ['an Eastern Arabic-Indic digit', 'SBAB۱۲'],
  ])('is refused by the schema with %s, which only the normaliser folds', (_, value) => {
    expect(storedTrackingFold(value)).not.toBe(normaliseTrackingNumber(value));
    expect(TrackingNumber.safeParse(value).success).toBe(false);
  });
});
