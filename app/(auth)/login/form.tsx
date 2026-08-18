'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signIn, type AuthFormState } from '../actions';
import { Button, ErrorText, Input, Label } from '@/components/ui';

const INITIAL: AuthFormState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState(signIn, INITIAL);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6"
    >
      <input type="hidden" name="next" value={next} />

      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}
