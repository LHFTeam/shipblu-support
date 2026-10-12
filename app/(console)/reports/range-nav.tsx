import Link from 'next/link';

/**
 * The 7/30/90-day switch over a rollup-backed page.
 *
 * Links rather than the design system's select, because a select changes the
 * page only through client JavaScript or a GET form, and these pages are
 * server-rendered with neither. The chosen range wears the selected tint the
 * views panel uses, not a filled blue: blue is what an action looks like, and
 * picking a window is a place you are, not a thing you do. `aria-current`
 * carries the same fact for anyone who cannot see the tint.
 */
export function RangeNav({
  ranges,
  current,
  href,
}: {
  ranges: readonly number[];
  current: number;
  href: (days: number) => string;
}) {
  return (
    <nav className="flex gap-1 text-sm">
      {ranges.map((days) => (
        <Link
          key={days}
          href={href(days)}
          aria-current={days === current ? 'page' : undefined}
          className="rounded-md px-2.5 py-1 text-(--color-text-secondary) transition-colors hover:bg-(--color-background-hover) hover:text-(--color-text-primary) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)"
        >
          {days} days
        </Link>
      ))}
    </nav>
  );
}
