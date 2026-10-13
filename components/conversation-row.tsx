import Link from 'next/link';
import type { ReactNode } from 'react';
import { channelInfo, channelMarkClass } from './channel';

/**
 * One conversation in a list: avatar-first by default — the person, the
 * channel's mark on their avatar, the latest line and the time — or the
 * three-line ticket row with `layout="ticket"`, where a subject leads.
 *
 * The whole row is one link, so nothing inside it may be a control: an assignee
 * tile cannot be a Tooltip button here, and a caller names it in visually
 * hidden text instead. There is no unread state, because nothing records what
 * an agent has read.
 *
 * `marker="fill"` insets the row as a rounded tint on the console's white
 * panel; it applies from `md`, because below that the list is full-bleed with
 * hairlines between rows. `marker="bar"` keeps the full-bleed row everywhere
 * and marks the open one with the 2px start bar.
 */
export function ConversationRow({
  layout = 'avatar',
  marker = 'fill',
  href,
  active,
  name,
  avatar,
  channel,
  time,
  preview,
  secondary,
  meta,
  trailing,
}: {
  layout?: 'avatar' | 'ticket';
  marker?: 'fill' | 'bar';
  href: string;
  active: boolean;
  name: string;
  /** The person's tile, avatar layout only. */
  avatar?: ReactNode;
  /** Drawn as a disc on the avatar's corner, avatar layout only. */
  channel?: string;
  time: ReactNode;
  preview: string;
  /** The ticket layout's second line. */
  secondary?: string | null;
  meta?: ReactNode;
  /** The end of the meta line: whose move it is, and whose ticket. */
  trailing?: ReactNode;
}) {
  const mark = channel ? { ...channelInfo(channel), className: channelMarkClass(channel) } : null;
  // The radius is important for the same reason as the focus offset below: the
  // focus rule's own radius would otherwise square the row off as it takes focus.
  const fill = marker === 'fill' ? 'md:mx-2 md:my-0.5 md:rounded-lg! md:border-b-0 md:px-3' : '';

  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      // The focus ring drawn inside the row: the list scrolls, and an outline
      // offset outward is clipped by the scroll box on a full-bleed row. With
      // `!` because the console's one focus rule in globals.css is unlayered,
      // and an unlayered rule outranks every utility that is not important.
      className={`relative flex items-start gap-3 border-b border-(--color-border-subtle) bg-(--color-background-surface) px-(--density-row-x) py-(--density-row-y) transition-colors hover:bg-(--color-background-hover) focus-visible:outline-offset-[-2px]! aria-[current=page]:bg-(--color-background-selected) ${fill}`}
    >
      {/* The open row is marked on its edge, which survives the hover state
          and reads at a glance down a long list. */}
      {marker === 'bar' && active ? (
        <span
          aria-hidden
          className="absolute inset-y-0 start-0 w-0.5 bg-(--color-marker-selected)"
        />
      ) : null}

      {layout === 'avatar' ? (
        <span className="relative flex flex-none">
          {avatar}
          {mark?.mark ? (
            <span
              role="img"
              aria-label={mark.label}
              className={`absolute -end-[5px] -bottom-[3px] ring-2 ring-(--color-background-surface) ${mark.className}`}
            >
              {mark.mark}
            </span>
          ) : null}
        </span>
      ) : null}

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span dir="auto" className="min-w-0 truncate text-sm leading-5 font-medium text-left">
            {name}
          </span>
          <span className="ms-auto shrink-0 text-xs text-(--color-text-secondary) tabular-nums">
            {time}
          </span>
        </span>

        {/* `dir="auto"` because the console is LTR and most of this text is
            Arabic: an RTL sentence truncated in an LTR box is cut at the wrong
            end, so the row showed the last words of a long reply and lost the
            ones that say what it is about. And aligned with the list rather than
            by its own direction (`text-left` — the console is always LTR, and
            Chromium ignores the unprefixed `match-parent` that would say so
            directly), so a short Arabic line still sits under the name rather
            than zig-zagging to the far edge: a line
            that overflows is laid out from its own start whatever the
            alignment, so it is still the sentence's end that is cut. */}
        <span
          dir="auto"
          className={`block truncate font-conversation text-sm text-left ${
            layout === 'ticket'
              ? 'leading-[22px] text-(--color-text-primary)'
              : 'leading-5 text-(--color-text-secondary)'
          }`}
        >
          {preview}
        </span>
        {layout === 'ticket' && secondary ? (
          <span
            dir="auto"
            className="block truncate font-conversation text-xs leading-[18px] text-(--color-text-secondary) text-left"
          >
            {secondary}
          </span>
        ) : null}

        {meta || trailing ? (
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {meta}
            {/* One group so the row wraps it as a unit: a wrap that separated
                its parts would put either one on a line by itself. */}
            {trailing ? (
              <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs text-(--color-text-secondary)">
                {trailing}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
