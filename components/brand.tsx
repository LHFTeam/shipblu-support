import type { ComponentProps } from 'react';

/**
 * The ShipBlu logomark.
 *
 * Inline SVG rather than a file in `public/`: the mark is five flat polygons,
 * so the vector is smaller than the smallest raster that would still be crisp
 * on a retina rail — and it needs no second request, no cache headers and no
 * `@2x` to stay sharp at every size it is drawn at.
 *
 * The `viewBox` is the mark's own bounding box, so a caller sizes it with a
 * width and lets whatever encloses it supply the padding.
 */
export function ShipBluMark({ className = '', ...props }: ComponentProps<'svg'>) {
  return (
    <svg
      viewBox="0 0 115.2 64.4"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      {...props}
    >
      {/* Left wing. */}
      <path fill="#145BFE" d="M0 0 44 0 74.7 15.35 52.7 26.35Z" />
      {/* Right wing, and the navy tip folded over its far edge. */}
      <path fill="#145BFE" d="M105.2 2.22 96.7 26.35 74.7 15.35Z" />
      <path fill="#022D65" d="M105.2 2.22 115.2 11.13 102.1 11.13Z" />
      {/* Body, cupped around the white the two wings leave between them. */}
      <path
        fill="#145BFE"
        d="M52.7 26.35 74.7 37.35 96.7 26.35 91.1 42.05 74.7 54.75 58.3 42.05Z"
      />
      {/* Tail. */}
      <path fill="#022D65" d="M58.3 42.05 74.7 54.75 43.7 63.92 24.1 64.34Z" />
    </svg>
  );
}

/**
 * The mark on the white rounded square it always appears in — an app icon.
 *
 * The white tile is what makes the mark readable on the navy rail, where the
 * navy half of the bird would otherwise sink into the background. The ring is
 * for the other case: on a light header, a white square on white needs an edge
 * to read as a shape at all.
 */
export function ShipBluLogo({ className = '' }: { className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[28%] bg-white shadow-sm ring-1 ring-black/5 ${className}`}
    >
      <ShipBluMark className="w-[76%]" />
    </span>
  );
}
