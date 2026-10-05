'use client';

import { bootstrapAdmin, type AuthFormState } from '../actions';
import { ErrorText, Input, Label } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AuthFormState = { error: null };

export function SetupForm() {
  const { state, form } = useActionForm(bootstrapAdmin, INITIAL);

  return (
    <form
      action={form.action}
      onSubmit={form.onSubmit}
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

      <SubmitButton idle="Create administrator" busy="Creating…" className="w-full" />
    </form>
  );
}
