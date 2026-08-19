import type { ReactNode } from 'react';
import { bands, compact, linePath, niceCeiling, split } from '@/lib/charts/scale';

/**
 * The two chart shapes the dashboard needs.
 *
 * Both are server-rendered SVG with no client JavaScript: a dashboard that
 * refreshes itself every fifteen seconds should not also be re-running a
 * charting library on every refresh. Hover detail comes from `<title>`, which
 * the browser shows as a tooltip and a screen reader reads out — one element
 * doing both jobs, with nothing to hydrate.
 *
 * Colour is assigned by series and never by rank, so a quiet day does not
 * repaint the chart. Values live in the accompanying table as well as on the
 * marks, so no figure is reachable only by reading a colour.
 */

const GRID = 'var(--chart-grid)';
const INK = 'var(--muted-foreground)';

export type Series = { label: string; values: number[]; color: string };

/** Legend swatches. Identity is the mark; the text stays in ink. */
export function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((one) => (
        <li
          key={one.label}
          className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]"
        >
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: one.color }} />
          {one.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Grouped columns over a categorical axis — days, hours.
 *
 * A column chart rather than two lines because the reader's job here is to
 * compare two magnitudes within each slot ("did we resolve as many as arrived
 * today?"), which side-by-side bars answer directly.
 */
export function Columns({
  labels,
  series,
  height = 132,
  width = 720,
  caption,
  tickEvery = 1,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  width?: number;
  /** Describes the chart for anyone who cannot see it. */
  caption: string;
  /** Draw every nth x label — a 90-day chart cannot carry ninety of them. */
  tickEvery?: number;
}) {
  const plotHeight = height - 18; // room for the x labels
  const peak = Math.max(0, ...series.flatMap((one) => one.values));
  const ceiling = niceCeiling(peak);
  const slots = bands(labels.length, width);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={caption} className="w-full">
        {/* Two hairlines rather than a grid: the baseline the bars grow from,
            and the ceiling the axis label names. */}
        <line x1="0" y1={plotHeight} x2={width} y2={plotHeight} stroke={GRID} strokeWidth="1" />
        <line
          x1="0"
          y1="0.5"
          x2={width}
          y2="0.5"
          stroke={GRID}
          strokeWidth="1"
          strokeOpacity="0.6"
        />

        {slots.map((slot, index) => {
          const parts = split(slot, series.length);

          return (
            <g key={index}>
              {series.map((one, seriesIndex) => {
                const value = one.values[index] ?? 0;
                const part = parts?.[seriesIndex] ?? slot;
                // Overlapping fallback for a band too narrow to split: the
                // second series draws thinner and on top, so both stay visible.
                const inset = parts ? 0 : seriesIndex * (slot.width / 4);
                const barWidth = Math.max(1, part.width - inset * 2);
                const barHeight = (Math.max(0, value) / ceiling) * plotHeight;

                return (
                  <rect
                    key={one.label}
                    x={part.x + inset}
                    y={plotHeight - barHeight}
                    width={barWidth}
                    height={Math.max(value > 0 ? 1 : 0, barHeight)}
                    rx={Math.min(4, barWidth / 2)}
                    fill={one.color}
                  >
                    <title>{`${labels[index]} · ${one.label}: ${value.toLocaleString('en-GB')}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {slots.map((slot, index) =>
          index % tickEvery === 0 || index === slots.length - 1 ? (
            <text
              key={index}
              x={slot.x + slot.width / 2}
              y={height - 4}
              textAnchor="middle"
              fontSize="10"
              fill={INK}
            >
              {labels[index]}
            </text>
          ) : null,
        )}
      </svg>

      {/* The tallest value, named rather than drawn as a ladder of gridlines.
          The axis itself stops at a round number above it — labelling *that*
          would claim a peak that never happened. */}
      <figcaption className="mt-1 flex items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
        <span>peak {compact(peak)}</span>
        <Legend series={series} />
      </figcaption>
    </figure>
  );
}

/**
 * A twelve-point trend inside a stat tile. One series, so no legend: the tile's
 * own label already says what is plotted.
 */
export function Sparkline({
  values,
  color = 'var(--series-1)',
  width = 120,
  height = 28,
  label,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) return null;

  // The plot stops short of the box so the end marker and its surface ring fit
  // inside it. Drawn to the full width they are sliced in half by the edge.
  const MARKER = 4;
  const plotWidth = width - MARKER;
  const plotHeight = height - MARKER;

  const ceiling = niceCeiling(Math.max(...values));
  const path = linePath(values, plotWidth, plotHeight, ceiling);
  const last = values.at(-1)!;
  const lastY = plotHeight - (Math.max(0, last) / ceiling) * plotHeight;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="w-full"
      preserveAspectRatio="none"
    >
      <path d={`${path} L${plotWidth},${height} L0,${height} Z`} fill={color} fillOpacity="0.1" />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The end marker carries a surface ring so it stays legible where it
          crosses the line or the edge of the tile. */}
      <circle
        cx={plotWidth}
        cy={lastY}
        r="3.5"
        fill={color}
        stroke="var(--surface)"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * One ratio against a limit — SLA attainment, and nothing else on this page.
 *
 * The track is the fill's own hue at low opacity rather than grey, so the state
 * reads across the whole bar and not only in the filled part.
 */
export function Meter({
  value,
  tone = 'good',
  label,
}: {
  /** 0–100, or null when there is nothing to measure. */
  value: number | null;
  tone?: 'good' | 'warning' | 'critical';
  label: string;
}) {
  const color = {
    good: 'var(--color-positive)',
    warning: 'var(--color-caution)',
    critical: 'var(--color-critical)',
  }[tone];

  return (
    <div
      role="meter"
      aria-valuenow={value ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: `color-mix(in oklch, ${color} 22%, transparent)` }}
    >
      <div className="h-full rounded-full" style={{ width: `${value ?? 0}%`, background: color }} />
    </div>
  );
}

/** A stat tile: label, value, optional hint, optional trend. */
export function Stat({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  /** Colours the value when the number itself is a state worth noticing. */
  tone?: 'critical' | 'caution';
  children?: ReactNode;
}) {
  const color =
    tone === 'critical'
      ? 'text-[var(--color-critical)]'
      : tone === 'caution'
        ? 'text-[var(--color-caution)]'
        : '';

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-[var(--muted-foreground)]">{label}</p>
      {/* Proportional figures: tabular-nums gives every digit a zero's width,
          which reads as loose spacing at this size. Columns of numbers in the
          tables below keep the console default. */}
      <p
        className={`mt-1 text-2xl font-semibold [font-variant-numeric:proportional-nums] ${color}`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
