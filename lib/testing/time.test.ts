import { describe, expect, it } from 'vitest';
import { cairo, inCairo } from './time';

describe('cairo', () => {
  // Written in UTC here on purpose, once, to prove the helper does not need it.
  it('converts on both sides of the DST changeover', () => {
    expect(cairo('2026-01-15T14:30').toISOString()).toBe('2026-01-15T12:30:00.000Z');
    expect(cairo('2026-08-15T14:30').toISOString()).toBe('2026-08-15T11:30:00.000Z');
  });

  // Egypt's 2026 changes: 24 April 00:00 jumps to 01:00; 30 October 00:00 falls
  // back to 29 October 23:00.
  it('converts either side of the spring change, and refuses the hour it skips', () => {
    expect(cairo('2026-04-23T23:59').toISOString()).toBe('2026-04-23T21:59:00.000Z');
    expect(cairo('2026-04-24T01:00').toISOString()).toBe('2026-04-23T22:00:00.000Z');
    expect(() => cairo('2026-04-24T00:30')).toThrow(/the clocks skip it/);
  });

  it('resolves the hour the autumn change repeats to its first, summer-time instance', () => {
    expect(cairo('2026-10-29T23:30').toISOString()).toBe('2026-10-29T20:30:00.000Z');
    expect(cairo('2026-10-30T00:00').toISOString()).toBe('2026-10-29T22:00:00.000Z');
  });

  it('refuses a string carrying its own offset, which would skip the conversion', () => {
    expect(() => cairo('2026-08-15T14:30:00+00:00')).toThrow(/names its own offset/);
    expect(() => cairo('2026-08-15T14:30Z')).toThrow(/names its own offset/);
    expect(() => cairo('2026-08-15T14:30+0300')).toThrow(/names its own offset/);
    expect(cairo('2026-08-15').toISOString()).toBe('2026-08-14T21:00:00.000Z');
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
