import { describe, expect, it } from 'vitest';
import { safeEqual } from './tokens';

describe('safeEqual', () => {
  it('matches only the identical value', () => {
    expect(safeEqual('s3cret-value', 's3cret-value')).toBe(true);
    expect(safeEqual('s3cret-value', 's3cret-valuE')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('refuses a different length rather than throwing', () => {
    expect(safeEqual('short', 'much longer')).toBe(false);
    expect(safeEqual('', 'anything')).toBe(false);
  });

  // What comparing the strings' `.length` would get wrong: equal in characters,
  // unequal in bytes, and `timingSafeEqual` throws on unequal bytes.
  it('refuses a value of the same length in characters but not in bytes', () => {
    expect('é'.length).toBe('e'.length);
    expect(() => safeEqual('é', 'e')).not.toThrow();
    expect(safeEqual('é', 'e')).toBe(false);
  });
});
