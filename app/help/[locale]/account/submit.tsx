'use client';

import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';

/**
 * Its own component because `useFormStatus` only reports the status of a form
 * *above* it in the tree — read inside the component that renders the `<form>`
 * it is always false, and the button never shows that anything is happening.
 */
export function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? busy : idle}
    </Button>
  );
}
