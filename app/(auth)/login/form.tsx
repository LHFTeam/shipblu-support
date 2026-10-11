'use client';

import { useEffect, useRef } from 'react';
import { signIn, type AuthFormState } from '../actions';
import { ErrorText, Input, Label } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AuthFormState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const { state, form } = useActionForm(signIn, INITIAL);
  const password = useRef<HTMLInputElement>(null);

  // A refused sign-in keeps the address and empties the password, for the
  // reasons the help centre's sign-in form gives.
  useEffect(() => {
    if (state.error && password.current) password.current.value = '';
  }, [state]);

  return (
    <form {...form} className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6">
      <input type="hidden" name="next" value={next} />

      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          ref={password}
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton idle="Sign in" busy="Signing in…" className="w-full" />
    </form>
  );
}
