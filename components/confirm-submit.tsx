'use client';

import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';

/**
 * The click half of a two-click control: the first click arms it, and only a
 * second, separate click confirms.
 *
 * Three things a plain `armed ? confirm : arm` gets wrong, each measured in
 * Chromium (§6.85):
 *
 * - **The arming click must not be the confirming one.** React commits a
 *   click's state update before the browser runs the click's default action, so
 *   a button whose `type` turns to `submit` in its own handler is already a
 *   submit button by the time that same click activates it. `MergeCandidateRow`
 *   merged on one click that way. `preventDefault` on the arming click cancels
 *   the activation; on a `type="button"` it costs nothing.
 * - **A double-click is one gesture, not two decisions.** Its second click
 *   lands on whatever the first one put there, so swapping in a separate
 *   confirm button does not help: the swap is what the second click hits. That
 *   click carries `detail` 2 — the platform's own count of clicks inside its
 *   double-click window — so anything above 1 is refused. A deliberate confirm
 *   inside that window (about half a second for a mouse) is swallowed and the
 *   next click confirms; a time-based guard was measured and was worse, because
 *   it also swallowed a quick keyboard confirm. Keyboard activation reports
 *   `detail` 0, so `=== 1` would lock the keyboard out entirely.
 * - **A held key repeats.** Enter activates a button on every keydown, repeats
 *   included, so holding it would arm and then confirm. A repeated keydown is
 *   cancelled, which cancels the click it would have produced.
 *
 * `onConfirm` is for a control that is not a submit button: the confirming
 * click calls it, and the control disarms once it settles. A submit button
 * passes nothing, and its confirm is the browser's own submission, which this
 * lets through.
 */
export function useConfirmClick(onConfirm?: () => Promise<unknown>) {
  const [armed, setArmed] = useState(false);
  const disarm = () => setArmed(false);

  return {
    armed,
    disarm,
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (!armed) {
        event.preventDefault();
        setArmed(true);
      } else if (event.detail > 1) {
        event.preventDefault();
      } else if (onConfirm) {
        void onConfirm().finally(disarm);
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.repeat) event.preventDefault();
    },
  };
}

/**
 * A form's destructive submit, behind one confirmation: a second click on the
 * same button rather than a dialog, which is enough to stop a mis-click and
 * needs no focus trap to be accessible.
 *
 * One `<button>` from first render to last, whose `type` and label change, so
 * focus stays where the agent left it — the confirm used to be a different
 * component, and arming one dropped focus to the page. Rendered inside the
 * `<form>`, because `useFormStatus` reports only a form above it, and disabled
 * while that form's action runs, so a click that lands mid-flight sends nothing.
 * The server still decides: a merge refuses a duplicate already folded in, and
 * a delete refuses a row that has gone.
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
  const { armed, onClick, onKeyDown } = useConfirmClick();
  const { pending } = useFormStatus();

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
