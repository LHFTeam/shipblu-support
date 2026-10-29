/**
 * Chart geometry.
 *
 * Kept apart from the components that draw with it so the arithmetic — which is
 * where a chart actually lies to you, by clipping a bar or inventing an axis
 * maximum — can be tested without rendering anything.
 *
 * There is no chart library here for the same reason there is no component
 * library: the console needs two chart shapes, and a dependency would cost more
 * in bundle size and upgrade churn than these forty lines.
 */

/**
 * A clean axis maximum at or above `value`.
 *
 * Axis ticks read as 0 / 25 / 50, never 0 / 23 / 46, and the maximum must never
 * fall below the tallest bar — a chart that clips its own data is worse than no
 * chart. `min` keeps an all-zero day from collapsing to a zero-height axis.
 */
export function niceCeiling(value: number, min = 1): number {
  const target = Math.max(value, min);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const steps = [1, 2, 2.5, 5, 10];

  for (const step of steps) {
    const candidate = step * magnitude;
    if (candidate >= target) return candidate;
  }

  return 10 * magnitude;
}

export type Band = { x: number; width: number };

/**
 * Evenly spaced slots across `width`, each capped at `maxBand`.
 *
 * The cap is what keeps a seven-day chart from drawing bars as wide as they are
 * tall: a band's leftover space is air, not more ink.
 */
export function bands(count: number, width: number, maxBand = 24, gap = 2): Band[] {
  if (count <= 0) return [];

  const step = width / count;
  const bandWidth = Math.max(1, Math.min(maxBand, step - gap));
  const offset = (step - bandWidth) / 2;

  return Array.from({ length: count }, (_, index) => ({
    x: index * step + offset,
    width: bandWidth,
  }));
}

/**
 * Split one band between `series` marks, leaving a 2px surface gap between
 * them. Below about six pixels a split band is two slivers, so the marks are
 * drawn overlapping instead — handled by the caller, which is why this returns
 * null rather than a width nobody can see.
 */
export function split(band: Band, series: number, gap = 2): Band[] | null {
  if (series <= 1) return [band];

  const width = (band.width - gap * (series - 1)) / series;
  if (width < 3) return null;

  return Array.from({ length: series }, (_, index) => ({
    x: band.x + index * (width + gap),
    width,
  }));
}

/** An x label: which slot, its centre as a percentage of the width, and whether it stays on a narrow screen. */
export type AxisTick = { index: number; at: number; narrow: boolean };

/**
 * The narrowest a chart is drawn, below `sm` and from it: a 360px phone and a
 * 640px window, each less the 74px of gutters and card padding around a chart
 * (a 390px window drew one 316px wide).
 */
const NARROW_CHART_PX = 286;
const WIDE_CHART_PX = 566;
/** A label's width per character at 11px: "22/10" measured 33px. */
const CHAR_PX = 6.6;
/** The least room between two labels that still reads as two. */
const LABEL_GAP_PX = 6;

/**
 * The x labels of a column chart, for labels drawn in HTML under the drawing:
 * which slots carry one, each at its slot's centre, and which of those stay
 * on a narrow screen.
 *
 * In HTML because an SVG's text shrinks with the drawing: at 390px a label
 * drawn at 10 units in a 720-unit box rendered at about 4px. A label in HTML
 * keeps its size, so its room is the constraint, and it is laid out here as
 * `Columns` draws it: centred on its slot, held inside the chart, as wide as
 * its characters at 11px. The candidates are every `tickEvery`th slot and the
 * last. At each width the fewest of them are thinned out — every second, then
 * every third — until no two are nearer than a gap, and any still crowding
 * the last, which always stays, are left out. A first pass at the narrowest
 * `sm` chart decides which are drawn at all, and a second, over those, at the
 * narrowest phone, which stay below `sm`. Rules in slot counts got the ends
 * wrong: a two-bar chart lost its first label, two-digit hours were thinned
 * as though they were dates, and between 66 and 75 days the first label,
 * held inside the edge, touched the second. "Left" here is the drawing's
 * own, which is left to right in either direction of text.
 */
export function axisTicks(
  slots: readonly Band[],
  width: number,
  labels: readonly string[],
  tickEvery = 1,
): AxisTick[] {
  const last = slots.length - 1;
  if (last < 0) return [];
  const every = Math.max(1, Math.floor(tickEvery));
  const centres = slots.map((slot) => (slot.x + slot.width / 2) / width);

  // Where a label is drawn on a chart `chart` px wide.
  const extent = (index: number, chart: number): [number, number] => {
    const labelWidth = (labels[index]?.length ?? 0) * CHAR_PX;
    const left = Math.min(
      Math.max(centres[index]! * chart - labelWidth / 2, 0),
      chart - labelWidth,
    );
    return [left, left + labelWidth];
  };

  const fit = (indices: readonly number[], chart: number): number[] => {
    const [lastLeft] = extent(last, chart);
    const regular = indices.filter((index) => index !== last);
    for (let step = 1; step <= Math.max(1, regular.length); step++) {
      const kept: number[] = [];
      let edge = -Infinity;
      let collided = false;
      for (const index of regular.filter((_, ordinal) => ordinal % step === 0)) {
        const [left, right] = extent(index, chart);
        // Crowding the last is not a reason to thin the rest: only this one goes.
        if (right + LABEL_GAP_PX > lastLeft) continue;
        if (left < edge + LABEL_GAP_PX) {
          collided = true;
          break;
        }
        kept.push(index);
        edge = right;
      }
      if (!collided) return [...kept, last];
    }
    return [last];
  };

  const candidates = centres.flatMap((_, index) =>
    index % every === 0 || index === last ? [index] : [],
  );
  const drawn = fit(candidates, WIDE_CHART_PX);
  const narrow = new Set(fit(drawn, NARROW_CHART_PX));
  return drawn.map((index) => ({ index, at: centres[index]! * 100, narrow: narrow.has(index) }));
}

/**
 * A polyline through `values`, scaled to fit `width` × `height`.
 *
 * y is flipped because SVG counts downwards, which is the single most common
 * way a hand-rolled sparkline ends up upside down.
 */
export function linePath(values: number[], width: number, height: number, max?: number): string {
  if (values.length === 0) return '';

  const ceiling = max ?? niceCeiling(Math.max(...values));
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (Math.max(0, value) / ceiling) * height;
      return `${index === 0 ? 'M' : 'L'}${round(x)},${round(y)}`;
    })
    .join(' ');
}

/**
 * Each value as a share of the largest, 0–100, for bars that share one track.
 *
 * Of the largest rather than of the total, so the longest bar fills its track
 * and the rest are read against it — five bars of a distribution measured
 * against the whole would leave most of every track empty. The share of the
 * total is printed beside each bar instead, where it can be read exactly.
 */
export function barWidths(values: readonly number[]): number[] {
  const peak = Math.max(0, ...values);
  return values.map((value) => (peak > 0 ? (Math.max(0, value) / peak) * 100 : 0));
}

/**
 * A whole percentage of `of`, or null when there is nothing to divide by:
 * the rounding the satisfaction report's rates and a bar's printed share
 * both start from. `RatingBars` then labels a step someone chose that rounds
 * to 0 as "<1", and one short of every answer that rounds to 100 as ">99",
 * which a rate does not.
 */
export function share(part: number, of: number): number | null {
  return of > 0 ? Math.round((part / of) * 100) : null;
}

/** "1,284", "12.9K", "1.2M" — a stat tile has room for four characters. */
export function compact(value: number): string {
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-GB');
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
