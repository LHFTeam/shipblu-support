import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The favicon is a second copy of the logomark, and this is what keeps it one.
 *
 * `app/icon.svg` cannot import from `components/brand.tsx` — Next's icon
 * convention wants a static file — so the five polygons exist twice. A drifted
 * copy is invisible: nobody inspects a 16px tab to check the tail is still the
 * right shape, and the first person to notice would be a customer.
 *
 * Compared as text rather than by rendering either one, so the test needs no
 * JSX transform and no DOM. It asserts the geometry and the fills, which is the
 * whole of the mark; the favicon's white tile and its placing transform are its
 * own and deliberately not checked here.
 */

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/** Every `fill="…" d="…"` pair in source order — the mark, and nothing else. */
function polygons(svg: string): { fill: string; d: string }[] {
  return [...svg.matchAll(/fill="(#[0-9A-Fa-f]{6})"\s+d="([^"]+)"/g)].map((match) => ({
    fill: match[1]!.toUpperCase(),
    // Prettier wraps a long path onto its own line in the JSX but not in the
    // SVG, so whitespace is normalised before comparing.
    d: match[2]!.replace(/\s+/g, ' ').trim(),
  }));
}

describe('the logomark and the favicon', () => {
  const mark = polygons(read('./brand.tsx'));
  const icon = polygons(read('../app/icon.svg'));

  it('are the same five polygons', () => {
    expect(mark).toHaveLength(5);
    expect(icon).toEqual(mark);
  });

  it('draw the mark in the brand blue and navy only', () => {
    expect(new Set(mark.map((one) => one.fill))).toEqual(new Set(['#145BFE', '#022D65']));
  });
});
