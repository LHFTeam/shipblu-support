import { describe, expect, it } from 'vitest';
import { safeEqual } from './tokens';

describe('safeEqual', () => {
  // Digests of a fixed length, so a wrong guess of another length is not
  // answered any sooner than one of the right length: it was, and that timed
  // answer gave away how long the secret is.
  it('compares values of different lengths as it compares values of the same length', () => {
    expect(safeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(safeEqual('a'.repeat(63), 'a'.repeat(64))).toBe(false);
    expect(safeEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

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
