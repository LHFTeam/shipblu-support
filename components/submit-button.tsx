'use client';

import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';

/**
 * A form's submit button, which shows while the form's action is running.
 *
 * Its own component because `useFormStatus` only reports the status of a form
 * *above* it in the tree — read inside the component that renders the `<form>`
 * it is always false, and the button never shows that anything is happening.
 *
 * One copy for the console, the sign-in pages and the help centre. There were
 * nine, differing only in their labels and class names, which each caller now
 * passes. `busy` defaults to the idle label with an ellipsis.
 */
export function SubmitButton({
  idle,
  busy,
  variant = 'primary',
  className = '',
  disabled = false,
}: {
  idle: string;
  busy?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  className?: string;
  /** Off for a reason outside the form; it is off while the form submits regardless. */
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending || disabled} className={className}>
      {pending ? (busy ?? `${idle}…`) : idle}
    </Button>
  );
}
