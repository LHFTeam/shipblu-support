import { describe, expect, it } from 'vitest';
import { allow, fits } from './rate-limit';

/** The counter every public endpoint shares, and the cost a budget in megabytes spends. */

let next = 0;
const key = () => `rate-limit-test:${++next}`;
const HOUR = 60 * 60 * 1000;

describe('allow', () => {
  it('lets the limit through and refuses the one after it, one at a time', () => {
    const k = key();
    expect([allow(k, 2, HOUR), allow(k, 2, HOUR), allow(k, 2, HOUR)]).toEqual([true, true, false]);
  });

  it('spends a cost larger than one, adding up across calls', () => {
    const k = key();
    expect(allow(k, 10, HOUR, 6)).toBe(true);
    expect(allow(k, 10, HOUR, 4)).toBe(true);
    expect(allow(k, 10, HOUR, 1)).toBe(false);
  });

  it('refuses a first request that costs more than the whole limit', () => {
    expect(allow(key(), 10, HOUR, 11)).toBe(false);
  });

  it('starts the window again once it has passed', () => {
    const k = key();
    expect(allow(k, 1, -1)).toBe(true);
    expect(allow(k, 1, HOUR)).toBe(true);
  });
});

describe('fits', () => {
  it('says whether a cost would fit, and spends nothing', () => {
    const k = key();
    expect(fits(k, 10, 10)).toBe(true);
    expect(fits(k, 10, 10)).toBe(true);
    expect(fits(k, 10, 11)).toBe(false);
  });

  it('counts what allow has spent in the window', () => {
    const k = key();
    allow(k, 10, HOUR, 7);
    expect(fits(k, 10, 3)).toBe(true);
    expect(fits(k, 10, 4)).toBe(false);
  });

  it('forgets a window that has passed', () => {
    const k = key();
    allow(k, 10, -1, 10);
    expect(fits(k, 10, 10)).toBe(true);
  });
});
