'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * The emoji the widget's picker offers, in the order a support chat reaches for
 * them: thanks and a smile first, then how the visitor feels about the parcel,
 * then the hands, then the parcel itself.
 *
 * A short, chosen list rather than the whole of Unicode. A full picker is a
 * library of a few hundred kilobytes and a search box of its own, inside a
 * 380px panel whose visitor came to ask where their order is; their phone's
 * keyboard has every emoji already, and this is for the ones a chat about a
 * delivery uses. Each is one grapheme as typed — the variation selector kept
 * on the ones that need it to draw in colour.
 *
 * They are the visitor's words once picked, so they are drawn as text in the
 * platform's emoji face and never replaced by an icon of ours, and a screen
 * reader names each one from the character itself.
 */
export const WIDGET_EMOJI = [
  '🙏',
  '😊',
  '🙂',
  '😀',
  '😁',
  '😂',
  '🤣',
  '😅',
  '😉',
  '😍',
  '🥰',
  '😘',
  '🤗',
  '🤔',
  '😐',
  '😕',
  '🙁',
  '😟',
  '😢',
  '😭',
  '😤',
  '😡',
  '😱',
  '🙄',
  '😴',
  '👍',
  '👎',
  '👌',
  '👏',
  '🤝',
  '👋',
  '💪',
  '🤲',
  '❤️',
  '💙',
  '🌹',
  '🎉',
  '🔥',
  '⭐',
  '💯',
  '✅',
  '❌',
  '⚠️',
  '❓',
  '⏰',
  '📅',
  '📦',
  '🚚',
  '🏠',
  '📍',
  '📞',
  '📱',
  '💰',
  '💵',
  '🧾',
  '🎁',
] as const;

/** How an emoji was picked, which decides where focus goes next. */
export type PickedWith = 'keyboard' | 'mouse' | 'touch';

/**
 * The panel of emoji under the composer, drawn in the flow rather than over the
 * conversation, as a phone's emoji keyboard takes the place of its letters: in
 * a framed panel a popover has nowhere to go that is not over the message it is
 * for, and one in the flow cannot be clipped by the frame.
 *
 * One tab stop for the whole grid, and the arrows move within it — a row of
 * fifty-six stops between the composer and whatever follows would be a wall to
 * a keyboard user. The columns are counted from the layout when an arrow is
 * pressed, because the grid fills its width rather than fixing a count.
 *
 * A pointer's press never takes focus (`onPointerDown`), so a click on desktop
 * leaves the caret in the message where the emoji went, and a tap on a phone
 * leaves its keyboard down while the visitor picks several. Opened from the
 * keyboard, it takes focus itself (`takeFocus`), since the arrows are the only
 * way in. Escape closes the panel, wherever focus is in it.
 */
export function EmojiPicker({
  id,
  label,
  takeFocus,
  onPick,
  onClose,
}: {
  id: string;
  label: string;
  /** Opened with Enter or Space on its button, so focus moves into the grid. */
  takeFocus: boolean;
  onPick: (emoji: string, pickedWith: PickedWith) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  /* The kind of pointer that pressed last, which a click event alone does not say in every engine. */
  const pointer = useRef<PickedWith>('mouse');

  const buttons = () =>
    Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  const moveTo = (index: number) => {
    const all = buttons();
    const next = Math.max(0, Math.min(all.length - 1, index));
    setActive(next);
    all[next]?.focus();
  };

  // As it opens: the grid is mounted fresh each time.
  useEffect(() => {
    if (takeFocus) grid.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [takeFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = buttons();
    const current = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (current === -1) return;

    // The emoji on the first row share its top edge, so they are the columns.
    const first = all[0]?.offsetTop;
    const columns = Math.max(1, all.filter((button) => button.offsetTop === first).length);
    // Left and right follow the panel's reading direction, not the keyboard's.
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];

    if (step !== undefined) moveTo(current + step);
    else if (event.key === 'ArrowDown') moveTo(current + columns);
    else if (event.key === 'ArrowUp') moveTo(current - columns);
    else if (event.key === 'Home') moveTo(0);
    else if (event.key === 'End') moveTo(all.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={grid}
      id={id}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="relative grid max-h-[min(11.5rem,40dvh)] grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] overflow-y-auto overscroll-contain rounded-md border border-(--color-border-subtle) bg-(--color-background-surface) p-1"
    >
      {WIDGET_EMOJI.map((emoji, index) => (
        <button
          key={emoji}
          type="button"
          tabIndex={index === active ? 0 : -1}
          onPointerDown={(event) => {
            pointer.current = event.pointerType === 'touch' ? 'touch' : 'mouse';
            // Keeps focus where it was: in the message on a desktop, nowhere
            // on a phone, whose keyboard would otherwise come back up.
            event.preventDefault();
          }}
          onClick={(event) => {
            setActive(index);
            // A click with no pointer behind it is Enter or Space.
            onPick(emoji, event.detail === 0 ? 'keyboard' : pointer.current);
          }}
          className="flex h-11 items-center justify-center rounded-md font-emoji text-2xl leading-none transition-colors hover:bg-(--color-background-hover) focus-visible:bg-(--color-background-hover) active:bg-(--color-background-pressed)"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
