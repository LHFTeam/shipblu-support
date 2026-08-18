'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { bootstrapAdmin, type AuthFormState } from '../actions';
import { Button, ErrorText, Input, Label } from '@/components/ui';

const INITIAL: AuthFormState = { error: null };

export function SetupForm() {
  const [state, action] = useActionState(bootstrapAdmin, INITIAL);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6"
    >
      <p className="text-sm opacity-70">
        No accounts exist yet. Create the first administrator to get started.
      </p>

      <div>
        <Label htmlFor="name">Your name</Label>
        <Input id="name" name="name" required autoFocus />
      </div>

      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className="mt-1 text-xs opacity-50">At least 12 characters.</p>
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
      {pending ? 'Creating…' : 'Create administrator'}
    </Button>
  );
}
