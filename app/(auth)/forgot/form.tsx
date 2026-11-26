'use client';

import Link from 'next/link';
import { requestReset, type AuthFormState } from '../actions';
import { ErrorText, Input, Label } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AuthFormState = { error: null };

export function ForgotForm() {
  const { state, form } = useActionForm(requestReset, INITIAL);

  return (
    <form {...form} className="flex flex-col gap-3.5">
      <p className="text-sm text-(--color-text-secondary)">
        Enter the address you sign in with and we will email you a link to choose a new password.
      </p>

      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton idle="Email me a reset link" busy="Sending…" className="w-full" />

      <p className="text-center text-sm">
        <Link
          href="/login"
          className="text-(--color-text-link) underline-offset-4 hover:text-(--color-text-link-hover) hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
