import { describe, expect, it } from 'vitest';
import { canonicalUuid, isUuid } from './uuid';

describe('isUuid', () => {
  it('accepts the canonical form, in either case', () => {
    expect(isUuid('0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44')).toBe(true);
    expect(isUuid('0B6F3C2E-8A51-4D3E-9F0A-2C7D1E5B9A44')).toBe(true);
  });

  it('refuses what Postgres would answer with 22P02', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('0b6f3c2e8a514d3e9f0a2c7d1e5b9a44')).toBe(false);
    expect(isUuid(' 0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44')).toBe(false);
    expect(isUuid('0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44x')).toBe(false);
  });

  it('refuses a value that is not a string at all', () => {
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(new File([], 'x'))).toBe(false);
  });
});

describe('canonicalUuid', () => {
  it('lower-cases a uuid, so a comparison in code agrees with the database', () => {
    expect(canonicalUuid('0B6F3C2E-8A51-4D3E-9F0A-2C7D1E5B9A44')).toBe(
      '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44',
    );
  });

  it('answers null for anything that is not one', () => {
    expect(canonicalUuid('not-a-uuid')).toBeNull();
    expect(canonicalUuid(null)).toBeNull();
  });
});
