import { describe, expect, it } from 'vitest';
import { isTimeout, sizedTimeout } from './deadline';

describe('isTimeout', () => {
  // The real signal, left to fire, rather than a DOMException built to match:
  // if a Node or undici upgrade changes what the deadline rejects with, every
  // client's timeout message would quietly fall back to "unreachable", and a
  // hand-built exception would keep this passing while it did.
  it('recognises the rejection AbortSignal.timeout() produces', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

    expect(isTimeout(signal.reason)).toBe(true);
    await expect(fetch('http://127.0.0.1:9', { signal })).rejects.toSatisfy(isTimeout);
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
