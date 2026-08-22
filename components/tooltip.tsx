'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { InfoIcon } from './icons';
import { placeTooltip, type Placed } from './tooltip-position';

/**
 * The console's explanation affordance.
 *
 * Two exports, one mechanism:
 *
 *   <InfoTip label="Ticket cap">The most open tickets…</InfoTip>
 *   <Tooltip label="Occupancy" content="Time on a ticket…">Occupancy</Tooltip>
 *
 * `InfoTip` is the common case — an ⓘ next to a label, where the children are
 * the explanation. `Tooltip` is for when the thing being explained is already
 * on screen and should become the trigger itself: a table header, a metric
 * name. Note the inversion, because it is the one thing easy to get wrong:
 * `InfoTip` takes the explanation as children, `Tooltip` takes the trigger.
 *
 * Three decisions worth keeping:
 *
 * **It renders into `document.body`.** Every admin table is inside
 * `overflow-x-auto` and the whole content column is inside `overflow-y-auto`,
 * so a bubble positioned inside the row is clipped by one or both — the
 * explanation for the last column of a wide table would have been a sliver. A
 * portal plus `position: fixed` escapes both without any ancestor needing to
 * know a tooltip exists.
 *
 * **It opens on tap, not only on hover.** The console is used on phones, where
 * hover does not exist and a `title=` attribute never appears at all. The
 * trigger is a real button so the same affordance answers a tap, a click, a
 * focus and a hover, and keyboard users reach it in tab order.
 *
 * **It closes on Escape and on the next pointer down.** A tooltip that can be
 * opened by tapping can also be left open, and one stuck over the field it
 * describes is worse than no tooltip.
 *
 * Not a dialog: the bubble takes no focus and traps none. It describes the
 * trigger through `aria-describedby`, which is what a screen reader announces
 * along with the control's own name.
 */

/** Hover has to be deliberate. Focus, click and tap open immediately. */
const HOVER_DELAY_MS = 120;

export function Tooltip({
  content,
  children,
  label,
  className = '',
}: {
  /** The explanation. */
  content: ReactNode;
  /** What the reader sees and interacts with. */
  children: ReactNode;
  /**
   * Names the trigger for assistive technology. Give one when the trigger is an
   * icon; leave it off when the trigger is the text being explained, which
   * names itself.
   */
  label?: string;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [open, setOpen] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);

  // Stable identities: `close` is a dependency of the listener effect below, so
  // a fresh closure each render would tear those listeners down and re-add them
  // on every parent re-render — which the console does on every inbound message.
  const cancelHover = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);

  const close = useCallback(() => {
    cancelHover();
    setOpen(false);
    setPlaced(null);
  }, [cancelHover]);

  useEffect(() => cancelHover, [cancelHover]);

  /*
   * Measured once the bubble is in the document, because its height depends on
   * how the text wrapped. It is rendered hidden until `placed` exists, so the
   * one frame between the two is invisible rather than a flash in the corner —
   * which is also why this is a plain effect and not a layout effect.
   */
  useEffect(() => {
    if (!open) return;

    function reposition() {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const bubble = bubbleRef.current?.getBoundingClientRect();
      if (!trigger || !bubble) return;

      setPlaced(
        placeTooltip(
          trigger,
          { width: bubble.width, height: bubble.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }

    reposition();

    // Capture, because the scroll that moves the trigger is a pane's, not the
    // window's — the admin content column and every table scroll themselves.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, content]);

  useEffect(() => {
    if (!open) return;

    // No focus to restore: the bubble never takes it, so a keyboard reader is
    // still on the trigger and moving focus here would only surprise someone
    // who opened this by hovering.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }

    function onPointerDown(event: PointerEvent) {
      if (triggerRef.current?.contains(event.target as Node)) return;
      close();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        onFocus={(event) => {
          /*
           * Keyboard focus only. A click focuses the button too, and opening on
           * that focus meant the click handler below immediately toggled it
           * shut again — on a phone, where a tap is the only way in, the
           * tooltip opened and closed within the same gesture and looked
           * broken.
           */
          if (event.target.matches(':focus-visible')) setOpen(true);
        }}
        onBlur={close}
        onPointerEnter={(event) => {
          // A tap fires this too, and the click handler already covers it.
          if (event.pointerType !== 'mouse') return;
          cancelHover();
          hoverTimer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'mouse') return;
          close();
        }}
        className={`inline-flex cursor-help items-center rounded-sm align-middle text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] ${className}`}
      >
        {children}
      </button>

      {open
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              style={{
                top: placed?.top ?? 0,
                left: placed?.left ?? 0,
                visibility: placed ? 'visible' : 'hidden',
              }}
              /*
               * `pointer-events-none` so the bubble cannot swallow the click
               * meant for whatever it is covering, and so leaving the trigger
               * always closes it. It costs text selection inside the bubble,
               * which is a fair trade for an explanation nobody needs to copy.
               *
               * The colours are the rail's, matching the labels on the nav rail:
               * a tooltip reads as a layer above the page rather than as another
               * panel on it, in both themes.
               */
              className="pointer-events-none fixed z-50 w-max max-w-[17rem] rounded-md bg-[var(--rail)] px-2.5 py-2 text-start text-xs leading-relaxed text-[var(--rail-foreground)] shadow-lg"
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * An ⓘ that explains the label it sits beside.
 *
 * `label` names the setting, not the button: it becomes "About ticket cap",
 * because "info" repeated fifteen times down a settings page tells a screen
 * reader reader nothing about which one they have landed on.
 */
export function InfoTip({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip content={children} label={`About ${label}`} className={className}>
      <InfoIcon size={14} />
    </Tooltip>
  );
}
