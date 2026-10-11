'use client';

import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';

/**
 * How long after one pointer click the next is still part of the same gesture:
 * Chromium 141's own double-click window as measured on Linux, about 500ms
 * from press to press, and longer than a tap's, 400ms from lift to landing
 * (§6.90). So a click the platform would have counted as a double-click is
 * caught even when it reported a single one.
 */
const BURST_MS = 500;

/**
 * The click half of a two-click control: the first click arms it, and only a
 * second, separate click confirms.
 *
 * Four things a plain `armed ? confirm : arm` gets wrong, each measured in
 * Chromium (§6.90):
 *
 * - **The arming click must not be the confirming one.** React commits a
 *   click's state update before the browser runs the click's default action, so
 *   a button whose `type` turns to `submit` in its own handler is already a
 *   submit button by the time that same click activates it. `MergeCandidateRow`
 *   merged on one click that way. `preventDefault` on the arming click cancels
 *   the activation; on a `type="button"` it costs nothing.
 * - **A double-click is one gesture, not two decisions.** Its second click
 *   lands on whatever the first one put there, so swapping in a separate
 *   confirm button does not help: the swap is what the second click hits.
 * - **The platform's click count does not see every double-click.** `detail`
 *   counts clicks inside the double-click window, but Chromium starts again at
 *   1 when the second press lands a few pixels from the first, and after
 *   every third click. So a pointer click within `BURST_MS` of the last one
 *   on this button is refused whatever its count, and so is any click the
 *   platform counts as a second or later, which covers a double-click window
 *   set longer than ours. The cost: a deliberate confirm inside half a second
 *   is swallowed, and the next click confirms. The keyboard is exempt — its
 *   activation reports `detail` 0 — because a guard on time alone swallowed a
 *   quick Enter, Enter.
 * - **A held Enter repeats.** Each Enter keydown, repeats included, produces
 *   the keypress that activates a focused button, so holding it would arm and
 *   then confirm. A repeated Enter is cancelled, which cancels that click. Only
 *   Enter: Space activates on release, and cancelling every repeat stopped a
 *   held arrow key or Tab at the button.
 *
 * `onConfirm` is for a control that is not a submit button: the confirming
 * click calls it, and the control disarms once it settles. A submit button
 * passes nothing, and its confirm is the browser's own submission, which this
 * lets through.
 */
export function useConfirmClick(onConfirm?: () => Promise<unknown>) {
  const [armed, setArmed] = useState(false);
  const lastPointerClick = useRef(-Infinity);
  const disarm = () => setArmed(false);

  return {
    armed,
    disarm,
    onClick(event: MouseEvent<HTMLButtonElement>) {
      const pointer = event.detail > 0;
      const burst = pointer && event.timeStamp - lastPointerClick.current < BURST_MS;
      if (pointer) lastPointerClick.current = event.timeStamp;

      // Refused before the arming check, armed or not: an action that answers
      // inside a double-click has disarmed the button by its second click, and
      // that click arming it again left the next single click a second send.
      if (burst || event.detail > 1) {
        event.preventDefault();
      } else if (!armed) {
        event.preventDefault();
        setArmed(true);
      } else if (onConfirm) {
        void onConfirm().finally(disarm);
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.repeat && event.key === 'Enter') event.preventDefault();
    },
  };
}

/**
 * A form's destructive submit, behind one confirmation: a second click on the
 * same button rather than a dialog, which is enough to stop a mis-click and
 * needs no focus trap to be accessible.
 *
 * One `<button>` from first render to last, whose `type` and label change, so
 * arming leaves focus where the agent put it — the confirm used to be a
 * different component, and arming one dropped focus to the page. Rendered
 * inside the `<form>`, because `useFormStatus` reports only a form above it.
 *
 * Disabled while the form's action runs, so a click that lands mid-flight sends
 * nothing; as with every `SubmitButton`, Chromium then moves focus to the page.
 * And disarmed when the action settles, either way: a retry after a refusal is
 * two clicks again, and so is a second delete of a row a success left on
 * screen. Without that, a press made mid-flight and released after the answer
 * sent the action a second time.
 *
 * It guards clicks and keys on itself and nothing else. In a form with a single
 * text field, Enter in that field submits without it, and once it is armed,
 * Enter in any of its form's text fields confirms it, because implicit
 * submission clicks the form's default button. So it must not share a form
 * with a text field. The server still decides what a submission means: a merge
 * refuses a duplicate already folded in, the Meta delete refuses a comment
 * already deleted, and an admin delete of a row that has gone deletes nothing.
 */
export function ConfirmSubmit({
  label,
  confirmLabel,
  busy,
  disabled = false,
}: {
  label: string;
  confirmLabel: string;
  busy?: string;
  /** Off for a reason outside the form, as `SubmitButton`'s is; off while the form submits regardless. */
  disabled?: boolean;
}) {
  const { armed, disarm, onClick, onKeyDown } = useConfirmClick();
  const { pending } = useFormStatus();

  // Disarm on the render that sees the action end, before that render commits,
  // so the button is never on screen enabled and still armed.
  const [running, setRunning] = useState(pending);
  if (pending !== running) {
    setRunning(pending);
    if (!pending) disarm();
  }

  return (
    <Button
      type={armed ? 'submit' : 'button'}
      variant={armed ? 'danger' : 'ghost'}
      size="sm"
      disabled={pending || disabled}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {pending ? (busy ?? `${confirmLabel}…`) : armed ? confirmLabel : label}
    </Button>
  );
}
