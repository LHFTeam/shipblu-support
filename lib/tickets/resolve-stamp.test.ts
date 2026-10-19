import { describe, expect, it } from 'vitest';
import { resolveStamp } from './resolve-stamp';

describe('resolveStamp', () => {
  it('stamps a resolve', () => {
    expect(resolveStamp('resolved').resolvedAt).toBeInstanceOf(Date);
  });

  it('clears it on a move back to Open or Pending', () => {
    expect(resolveStamp('open')).toEqual({ resolvedAt: null });
    expect(resolveStamp('pending')).toEqual({ resolvedAt: null });
  });

  // Left out of the update, not written: a value would either clear the
  // resolve the close follows or stamp one nobody made.
  it('leaves it out of a close altogether', () => {
    expect(resolveStamp('closed')).toEqual({});
    expect('resolvedAt' in resolveStamp('closed')).toBe(false);
  });
});
