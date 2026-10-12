'use client';

import { useId, useState, type ReactNode } from 'react';
import { ChevronDownIcon } from './icons';

/**
 * A titled block in the ticket's details column — the contact, the shipments,
 * the conversation's own fields — that folds away in place.
 *
 * A client module of its own because folding needs state, and `ui.tsx` is
 * rendered from server components too, where a click handler would fail the
 * render (the reason `search-input.tsx` gives).
 *
 * Folded with `hidden` rather than by unmounting the body, for the reason
 * `Collapsible` in the admin forms gives: a block can hold a control an agent
 * is half-way through, and folding it must not throw that away. Nothing is
 * remembered across visits; every block opens as `defaultOpen` says.
 *
 * The title is an `h2`, because the thread's `h1` is the only heading above it.
 */
export function DetailsSection({
  title,
  action,
  collapsible = true,
  defaultOpen = true,
  variant = 'plain',
  children,
}: {
  title?: ReactNode;
  /** A small control at the end of the header, outside the fold button: a ghost "Link". */
  action?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /**
   * `plain` divides blocks in a white column with a hairline; `card` is a
   * bordered card of its own, for a block set on the canvas; `flush` has
   * neither, for a block that is the whole of a tab.
   */
  variant?: 'plain' | 'card' | 'flush';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const shown = !collapsible || open;

  const frame = {
    plain: 'border-b border-(--color-border-subtle)',
    card: 'rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface)',
    flush: '',
  }[variant];

  const titleText = 'text-xs font-semibold text-(--color-text-secondary)';

  return (
    <section className={frame}>
      {title ? (
        <div
          className={`flex min-h-6 items-center gap-1.5 px-(--density-row-x) pt-3.5 ${shown ? 'pb-2.5' : 'pb-3.5'}`}
        >
          <h2 className="flex min-w-0 flex-1">
            {collapsible ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen(!open)}
                className={`flex min-w-0 flex-1 items-center gap-1.5 text-start transition-colors hover:text-(--color-text-primary) ${titleText}`}
              >
                {/* Down when open; toward the inline end when folded, which is
                    the other way round in Arabic. */}
                <ChevronDownIcon
                  size={16}
                  className={`shrink-0 transition-transform ${open ? '' : '-rotate-90 rtl:rotate-90'}`}
                />
                {title}
              </button>
            ) : (
              <span className={`min-w-0 ${titleText}`}>{title}</span>
            )}
          </h2>
          {action ? <span className="flex shrink-0 items-center">{action}</span> : null}
        </div>
      ) : null}
      <div id={id} hidden={!shown} className={`px-(--density-row-x) pb-4 ${title ? '' : 'pt-4'}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * Label and value pairs, two columns with the labels at 92px.
 *
 * Children rather than the design system's array of tuples, because the rows
 * here are conditional and each has its reason written beside it; `Property`
 * leaves itself out when it has nothing to say, so the caller does not wrap
 * every row in a check.
 */
export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="grid gap-2">{children}</dl>;
}

/**
 * One row of a `PropertyList`. Renders nothing for a value that is `null`,
 * `undefined` or the empty string — but a `0` is a value and is shown.
 *
 * `ltr` is for a phone number, a tracking number or an id: in an Arabic page
 * `+20 100…` would otherwise be laid out with its digits in the wrong order.
 */
export function Property({
  label,
  value,
  ltr = false,
}: {
  label: ReactNode;
  value: ReactNode;
  ltr?: boolean;
}) {
  if (value === null || value === undefined || value === '') return null;

  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-sm">
      <dt className="text-(--color-text-secondary)">{label}</dt>
      <dd dir={ltr ? 'ltr' : undefined} className="min-w-0 wrap-anywhere">
        {value}
      </dd>
    </div>
  );
}
