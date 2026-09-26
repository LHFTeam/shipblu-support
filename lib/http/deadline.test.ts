import { describe, expect, it } from 'vitest';
import { isTimeout, sizedTimeout } from './deadline';

describe('isTimeout', () => {
  it('recognises the rejection AbortSignal.timeout() produces', async () => {
    const signal = AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(isTimeout(signal.reason)).toBe(true);
  });

  // An abort somebody asked for, and a network failure, are not a deadline, and
  // a message naming the seconds would misreport them.
  it('does not mistake another abort or a network failure for one', () => {
    expect(isTimeout(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isTimeout(new TypeError('fetch failed'))).toBe(false);
    expect(isTimeout('TimeoutError')).toBe(false);
  });
});

describe('sizedTimeout', () => {
  it.each([
    [0, 60_000],
    [1, 61_000],
    [2 * 1024 * 1024, 61_000],
    [2 * 1024 * 1024 + 1, 62_000],
    [100 * 1024 * 1024, 110_000],
  ])('gives %i bytes %i ms', (bytes, expected) => {
    expect(sizedTimeout(bytes)).toBe(expected);
  });
});
