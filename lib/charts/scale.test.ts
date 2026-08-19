import { describe, expect, it } from 'vitest';
import { bands, compact, linePath, niceCeiling, split } from './scale';

describe('niceCeiling', () => {
  it('rounds up to a readable tick', () => {
    expect(niceCeiling(23)).toBe(25);
    expect(niceCeiling(46)).toBe(50);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(101)).toBe(200);
  });

  it('never falls below the value, which would clip the tallest bar', () => {
    for (const value of [1, 3, 9, 17, 99, 100, 251, 1_000, 4_321]) {
      expect(niceCeiling(value)).toBeGreaterThanOrEqual(value);
    }
  });

  it('keeps an all-zero day from collapsing the axis', () => {
    expect(niceCeiling(0)).toBe(1);
  });
});

describe('bands', () => {
  it('spaces slots evenly across the width', () => {
    const result = bands(4, 400, 100, 0);
    expect(result.map((band) => band.x)).toEqual([0, 100, 200, 300]);
    expect(result.every((band) => band.width === 100)).toBe(true);
  });

  it('caps the bar width and centres the leftover as air', () => {
    const [first] = bands(2, 400, 24);
    expect(first!.width).toBe(24);
    expect(first!.x).toBe(88); // (200 - 24) / 2
  });

  it('stays inside the plot for a crowded chart', () => {
    const result = bands(90, 600);
    const last = result.at(-1)!;
    expect(last.x + last.width).toBeLessThanOrEqual(600);
    expect(result.every((band) => band.width >= 1)).toBe(true);
  });

  it('returns nothing for an empty series', () => {
    expect(bands(0, 400)).toEqual([]);
  });
});

describe('split', () => {
  it('leaves a surface gap between the marks', () => {
    const parts = split({ x: 0, width: 22 }, 2)!;
    expect(parts).toHaveLength(2);
    expect(parts[0]!.width).toBe(10);
    expect(parts[1]!.x).toBe(12);
  });

  it('refuses to split a band into slivers', () => {
    expect(split({ x: 0, width: 6 }, 2)).toBeNull();
  });

  it('passes a single series through untouched', () => {
    expect(split({ x: 4, width: 12 }, 1)).toEqual([{ x: 4, width: 12 }]);
  });
});

describe('linePath', () => {
  it('flips y, so a rising series rises', () => {
    const path = linePath([0, 10], 100, 50, 10);
    expect(path).toBe('M0,50 L100,0');
  });

  it('draws a single point without dividing by zero', () => {
    expect(linePath([5], 100, 50, 10)).toBe('M0,25');
  });

  it('is empty for no data rather than a stray "M"', () => {
    expect(linePath([], 100, 50)).toBe('');
  });
});

describe('compact', () => {
  it('keeps small numbers exact and thousands-separated', () => {
    expect(compact(0)).toBe('0');
    expect(compact(1_284)).toBe('1,284');
  });

  it('abbreviates once a value stops fitting a tile', () => {
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(20_000)).toBe('20K');
    expect(compact(1_200_000)).toBe('1.2M');
  });
});
