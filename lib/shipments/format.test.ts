import { describe, expect, it } from 'vitest';
import { couldBeReference, normaliseSbid, normaliseTrackingNumber } from './format';

/**
 * Normalising strips the separators people write inside an identifier, not
 * every character that is not part of one — so what comes out of a search box
 * is not yet known to be a reference. A `%` typed on its own survived both
 * normalisers, reached the contact search as a tracking number and an SBID, and
 * became a wildcard that listed every parcel and every account.
 */
describe('couldBeReference', () => {
  it('accepts what a tracking number or an SBID normalises to', () => {
    expect(couldBeReference(normaliseTrackingNumber('SB-1234 5678'))).toBe(true);
    expect(couldBeReference(normaliseTrackingNumber('١٧٥٥٠٢١٣٥٨٧١٩'))).toBe(true);
    expect(couldBeReference(normaliseSbid('SBID-4471'))).toBe(true);
  });

  it('refuses a value holding anything a reference cannot', () => {
    expect(normaliseTrackingNumber('%')).toBe('%');
    expect(couldBeReference(normaliseTrackingNumber('%'))).toBe(false);
    expect(couldBeReference(normaliseSbid('SB%'))).toBe(false);
    expect(couldBeReference(normaliseTrackingNumber('50%'))).toBe(false);
  });

  it('refuses the empty string a punctuation-only query normalises to', () => {
    expect(couldBeReference(normaliseTrackingNumber('--'))).toBe(false);
  });
});
