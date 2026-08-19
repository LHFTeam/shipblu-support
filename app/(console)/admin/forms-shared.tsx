'use client';

import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, Card, ErrorText } from '@/components/ui';
import type { SettingsState } from './settings-actions';

/**
 * The shape every admin editor shares: a disclosure that opens a form, submits
 * a server action, and closes itself when the action succeeds.
 *
 * Written once because there are eight of these screens, and eight hand-rolled
 * copies of "did it save? then close and refresh" is eight chances for one of
 * them to leave a stale list on screen.
 */

export const INITIAL: SettingsState = { error: null };

export function SubmitButton({
  idle,
  busy,
  variant = 'primary',
  className = '',
}: {
  idle: string;
  busy?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} className={className}>
      {pending ? (busy ?? `${idle}…`) : idle}
    </Button>
  );
}

/** Refreshes the server components after a successful write. */
export function useRefreshOnSuccess(state: SettingsState, onSuccess?: () => void) {
  const router = useRouter();
  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
    onSuccess?.();
    // `nonce` changes on every success, so two consecutive saves both fire.
  }, [state.ok, state.nonce, router, onSuccess]);
}

export function EditorForm({
  action,
  children,
  submitLabel,
  onSaved,
}: {
  action: (state: SettingsState, formData: FormData) => Promise<SettingsState>;
  children: ReactNode;
  submitLabel: string;
  onSaved?: () => void;
}) {
  const [state, formAction] = useActionState(action, INITIAL);
  useRefreshOnSuccess(state, onSaved);

  return (
    <form action={formAction} className="flex flex-col gap-3">
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

  return (
    <Card className="border-brand-500/30">
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
}: {
  action: (state: SettingsState, formData: FormData) => Promise<SettingsState>;
  id: string;
  label?: string;
  confirmLabel?: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL);
  const [armed, setArmed] = useState(false);
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={id} />
      {armed ? (
        <SubmitButton idle={confirmLabel} variant="danger" />
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setArmed(true)}>
          {label}
        </Button>
      )}
      {state.error ? (
        <span className="max-w-xs text-end text-xs text-red-600 dark:text-red-400">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
