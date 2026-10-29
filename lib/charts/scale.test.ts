import { describe, expect, it } from 'vitest';
import { axisTicks, bands, barWidths, compact, linePath, niceCeiling, split } from './scale';

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

describe('axisTicks', () => {
  // Four 100-unit slots with no gap, so a slot's edges are round percentages.
  const four = bands(4, 400, 100, 0);

  it('puts each label at its slot’s centre', () => {
    expect(axisTicks(four, 400)).toEqual([
      { index: 0, at: 12.5, narrow: true },
      { index: 1, at: 37.5, narrow: true },
      { index: 2, at: 62.5, narrow: true },
      { index: 3, at: 87.5, narrow: true },
    ]);
  });

  it('labels every nth slot and always the last', () => {
    const thirty = bands(30, 720);
    expect(axisTicks(thirty, 720, 7).map((tick) => tick.index)).toEqual([0, 7, 14, 21, 29]);
  });

  it('leaves out a regular label nearer the last than the spacing, which would touch it', () => {
    // 30 days at every 5th: the 25th sits four slots from the pinned 29th.
    const thirty = bands(30, 720);
    expect(axisTicks(thirty, 720, 5).map((tick) => tick.index)).toEqual([0, 5, 10, 15, 20, 29]);
    // 90 days at every 10th: the 80th is nine from the 89th.
    const ninety = bands(90, 720);
    expect(axisTicks(ninety, 720, 10).map((tick) => tick.index)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 89,
    ]);
  });

  it('keeps every label when every slot is labelled', () => {
    expect(axisTicks(bands(7, 720), 720, 1).map((tick) => tick.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('labels a lone slot, at the middle', () => {
    expect(axisTicks(bands(1, 720), 720, 3)).toEqual([{ index: 0, at: 50, narrow: true }]);
  });

  it('keeps every other label on a phone where the spacing is too tight for a date', () => {
    // Ninety days at every tenth is about 33px a step on a phone: "31/7" and
    // "10/8" ran together there.
    const ninety = axisTicks(bands(90, 720), 720, 10);
    const onPhone = ninety.filter((tick) => tick.narrow).map((tick) => tick.index);
    expect(onPhone).toEqual([0, 20, 40, 60, 89]);
    // An hour chart's 24 slots at every third: and none within six of the last.
    const hours = axisTicks(bands(24, 720), 720, 3);
    expect(hours.filter((tick) => tick.narrow).map((tick) => tick.index)).toEqual([0, 6, 12, 23]);
  });

  it('keeps every label on a phone where the spacing already fits', () => {
    // Thirty days at every fifth is 50px a step, and seven days at every one 43px.
    expect(axisTicks(bands(30, 720), 720, 5).every((tick) => tick.narrow)).toBe(true);
    expect(axisTicks(bands(7, 720), 720, 1).every((tick) => tick.narrow)).toBe(true);
  });

  it('draws nothing for no slots, and treats a spacing below one as one', () => {
    expect(axisTicks([], 720, 5)).toEqual([]);
    expect(axisTicks(four, 400, 0)).toHaveLength(4);
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

describe('barWidths', () => {
  it('fills the track with the largest bar and measures the rest against it', () => {
    expect(barWidths([1, 4, 2, 0, 8])).toEqual([12.5, 50, 25, 0, 100]);
  });

  it('draws nothing for nothing, rather than dividing by it', () => {
    expect(barWidths([0, 0, 0])).toEqual([0, 0, 0]);
    expect(barWidths([])).toEqual([]);
  });

  it('never draws a negative bar', () => {
    expect(barWidths([-2, 4])).toEqual([0, 100]);
  });
});
