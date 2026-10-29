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
  // Day labels as the dashboard writes them, ending on 28 October.
  const days = (count: number) =>
    Array.from({ length: count }, (_, index) => {
      const day = new Date(Date.UTC(2026, 9, 28 - (count - 1 - index)));
      return `${day.getUTCDate()}/${day.getUTCMonth() + 1}`;
    });
  const hours = (count: number) =>
    Array.from({ length: count }, (_, index) => String(index).padStart(2, '0'));
  const indices = (ticks: { index: number }[]) => ticks.map((tick) => tick.index);
  const onPhone = (ticks: { index: number; narrow: boolean }[]) =>
    ticks.filter((tick) => tick.narrow).map((tick) => tick.index);

  it('puts each label at its slot’s centre', () => {
    const four = bands(4, 400, 100, 0);
    expect(axisTicks(four, 400, ['a', 'b', 'c', 'd'])).toEqual([
      { index: 0, at: 12.5, narrow: true },
      { index: 1, at: 37.5, narrow: true },
      { index: 2, at: 62.5, narrow: true },
      { index: 3, at: 87.5, narrow: true },
    ]);
  });

  it('labels every nth slot and the last, on a phone too, where they fit', () => {
    const thirty = axisTicks(bands(30, 720), 720, days(30), 5);
    expect(indices(thirty)).toEqual([0, 5, 10, 15, 20, 25, 29]);
    // "24/10" would sit within a gap of "28/10", held inside the edge.
    expect(onPhone(thirty)).toEqual([0, 5, 10, 15, 20, 29]);
    expect(onPhone(axisTicks(bands(7, 720), 720, days(7), 1))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('thins a phone’s labels evenly where dates run together', () => {
    // Ninety days at every tenth is about 3px a slot on a phone, and "31/7"
    // ran into "10/8" there.
    const ninety = axisTicks(bands(90, 720), 720, days(90), 10);
    expect(indices(ninety)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 89]);
    expect(onPhone(ninety)).toEqual([0, 20, 40, 60, 89]);
  });

  it('keeps two-digit hours that fit, which a rule for dates thinned', () => {
    expect(onPhone(axisTicks(bands(24, 720), 720, hours(24), 3))).toEqual([
      0, 3, 6, 9, 12, 15, 18, 21, 23,
    ]);
  });

  it('keeps the first label of a chart shorter than its spacing', () => {
    // Just after midnight the hour chart has two bars, labelled every second.
    expect(indices(axisTicks(bands(2, 720), 720, hours(2), 2))).toEqual([0, 1]);
  });

  it('never draws two labels nearer than a gap, at any length, on a phone or wider', () => {
    // Held inside the edge, the first label sat on the second between 66 and
    // 75 days at every tenth. Laid out as `Columns` draws them, at 6.6px a
    // character, every kept pair clears 6px at both widths.
    for (const every of [1, 2, 3, 5, 10]) {
      for (let count = 1; count <= 90; count++) {
        const labels = days(count);
        const ticks = axisTicks(bands(count, 720), 720, labels, every);
        for (const [chart, shown] of [
          [566, ticks],
          [286, ticks.filter((tick) => tick.narrow)],
        ] as const) {
          const boxes = shown.map((tick) => {
            const labelWidth = labels[tick.index]!.length * 6.6;
            const left = Math.min(
              Math.max((tick.at / 100) * chart - labelWidth / 2, 0),
              chart - labelWidth,
            );
            return [left, left + labelWidth] as const;
          });
          for (let index = 1; index < boxes.length; index++) {
            expect(boxes[index]![0] - boxes[index - 1]![1]).toBeGreaterThanOrEqual(6);
          }
          expect(shown.at(-1)?.index).toBe(count - 1);
        }
      }
    }
  });

  it('labels a lone slot, at the middle, and nothing for no slots', () => {
    expect(axisTicks(bands(1, 720), 720, ['00'], 3)).toEqual([{ index: 0, at: 50, narrow: true }]);
    expect(axisTicks([], 720, [], 5)).toEqual([]);
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
