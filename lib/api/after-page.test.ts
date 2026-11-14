import { describe, expect, it } from 'vitest';
import { afterPage, type AfterRow } from './after-page';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, fresh: boolean, placeTime = `20261114210700${String(n).padStart(6, '0')}`) {
  return { fresh, placeTime, id: id(n) } satisfies AfterRow;
}

/** Every order the halves could arrive in, from a few interleavings. */
function shuffles<T>(rows: T[]): T[][] {
  return [
    rows,
    [...rows].reverse(),
    [...rows.filter((_, i) => i % 2), ...rows.filter((_, i) => !(i % 2))],
  ];
}

describe('afterPage', () => {
  it('answers the same page and cursor however the union handed the rows over', () => {
    // Overlap 1–4 at or before the cursor, fresh 5–7 after it; a page of 6.
    const rows = [1, 2, 3, 4].map((n) => row(n, false)).concat([5, 6, 7].map((n) => row(n, true)));
    for (const arrived of shuffles(rows)) {
      const { page, newest } = afterPage(arrived, 6);
      // Room for two of the overlap, the newest two, short of the last place.
      expect(page.map((r) => r.id)).toEqual([3, 4, 5, 6, 7].map(id));
      expect(newest?.id).toBe(id(7));
    }
  });

  it('gives the overlap no room once the fresh rows fill the page short of its last place', () => {
    const rows = [row(1, false), row(2, true), row(3, true)];
    for (const arrived of shuffles(rows)) {
      expect(afterPage(arrived, 3).page.map((r) => r.id)).toEqual([id(2), id(3)]);
    }
  });

  it('breaks a tie in the microsecond by the id, as Postgres orders the row value', () => {
    const at = '20261114210700000001';
    const rows = [row(9, true, at), row(2, true, at)];
    for (const arrived of shuffles(rows)) {
      const { page, newest } = afterPage(arrived, 10);
      expect(page.map((r) => r.id)).toEqual([id(2), id(9)]);
      expect(newest?.id).toBe(id(9));
    }
  });

  it('answers no newest row when nothing is after the cursor', () => {
    expect(afterPage([row(1, false), row(2, false)], 5)).toEqual({
      page: [row(1, false), row(2, false)],
      newest: undefined,
    });
  });
});
