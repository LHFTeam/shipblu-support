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

/** "1,284", "12.9K", "1.2M" — a stat tile has room for four characters. */
export function compact(value: number): string {
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-GB');
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
