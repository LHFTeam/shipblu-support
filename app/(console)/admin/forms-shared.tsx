'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { Button, Card, ErrorText } from '@/components/ui';
import type { ActionState } from '@/lib/http/action-state';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

/**
 * The shape every admin editor shares: a disclosure that opens a form, submits
 * a server action, and closes itself when the action succeeds.
 *
 * Written once because there are eight of these screens, and eight hand-rolled
 * copies of "did it save? then close and refresh" is eight chances for one of
 * them to leave a stale list on screen.
 */

export const INITIAL: ActionState = { error: null };

export function EditorForm({
  action,
  children,
  submitLabel,
  onSaved,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: ReactNode;
  submitLabel: string;
  onSaved?: () => void;
}) {
  const { state, form } = useActionForm(action, INITIAL, { onSuccess: onSaved });

  return (
    <form {...form} className="flex flex-col gap-3">
      {children}
      <ErrorText>{state.error}</ErrorText>
      <SubmitButton idle={submitLabel} className="self-start" />
    </form>
  );
}

/**
 * A "New …" button that reveals a form in place.
 *
 * In place rather than in a modal: these forms are tall — an SLA policy has
 * twelve targets — and a dialog that scrolls inside a page that also scrolls is
 * worse than simply making room.
 */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  // `data-expanded` is what a page header keys off to give the open form the
  // whole row instead of the corner it puts the button in.
  return (
    <Card data-expanded className="w-full border-brand-500/30">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{label}</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      </div>
      {children(() => setOpen(false))}
    </Card>
  );
}

/**
 * A section of a form that starts folded, **without unmounting what is inside**.
 *
 * `Disclosure` above renders nothing until it is opened, which is right for a
 * "New …" form that does not exist yet and catastrophic for a group of fields
 * inside a form that already does: an input that is not in the DOM is not in the
 * FormData either, so a save while the section was folded read every one of
 * those fields as blank and wrote the record back with them cleared. That is how
 * a field's validation rules were being deleted by an admin who only renamed it.
 *
 * So this hides with `hidden` rather than by returning early. The inputs stay
 * mounted, keep their values, and submit exactly as if the section were open.
 */
export function Collapsible({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-xs font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        {open ? '▾' : '▸'} {label}
      </button>
      <div hidden={!open} className="mt-3 flex flex-col gap-3">
        {children}
      </div>
    </div>
  );
}

/**
 * A destructive action behind one confirmation.
 *
 * The confirm is a second click on the same button rather than a dialog: it is
 * enough to stop a mis-click and does not need a focus trap to be accessible.
 */
export function DangerAction({
  action,
  id,
  label = 'Delete',
  confirmLabel = 'Really delete?',
  disabled = false,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  id: string;
  label?: string;
  confirmLabel?: string;
  /** Off while something beside it must not be undone underneath — armed or not. */
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, INITIAL);
  const [armed, setArmed] = useState(false);

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={id} />
      {armed ? (
        <SubmitButton idle={confirmLabel} variant="danger" disabled={disabled} />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setArmed(true)}
          disabled={disabled}
        >
          {label}
        </Button>
      )}
      {state.error ? (
        <span className="max-w-xs text-end text-xs text-red-600">{state.error}</span>
      ) : null}
    </form>
  );
}
