import { describe, expect, it } from 'vitest';
import { cairo, inCairo } from './time';

describe('cairo', () => {
  // Written in UTC here on purpose, once, to prove the helper does not need it.
  it('converts on both sides of the DST changeover', () => {
    expect(cairo('2026-01-15T14:30').toISOString()).toBe('2026-01-15T12:30:00.000Z');
    expect(cairo('2026-08-15T14:30').toISOString()).toBe('2026-08-15T11:30:00.000Z');
  });

  it('refuses a string it cannot read, rather than returning an Invalid Date', () => {
    expect(() => cairo('2026-02-30T09:00')).toThrow(/not a Cairo wall-clock time/);
    expect(() => cairo('half past nine')).toThrow(/not a Cairo wall-clock time/);
  });
});

describe('inCairo', () => {
  it('reads an instant back as the Cairo wall clock it was built from', () => {
    expect(inCairo(cairo('2026-08-15T14:30'))).toBe('2026-08-15T14:30');
    expect(inCairo(new Date('2026-01-15T22:30:00Z'))).toBe('2026-01-16T00:30');
  });

  it('passes an absent instant through as null', () => {
    expect(inCairo(null)).toBeNull();
    expect(inCairo(undefined)).toBeNull();
  });
});
