'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { acceptInvite, type AuthFormState } from '../../actions';
import { Button, ErrorText, Input, Label } from '@/components/ui';

const INITIAL: AuthFormState = { error: null };

export function InviteForm({
  token,
  email,
  name,
}: {
  token: string;
  email: string;
  name: string | null;
}) {
  const [state, action] = useActionState(acceptInvite, INITIAL);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6"
    >
      <input type="hidden" name="token" value={token} />

      <p className="text-sm opacity-70">
        Set a password for <span className="font-medium opacity-100">{email}</span>.
      </p>

      <div>
        <Label htmlFor="name">Your name</Label>
        <Input id="name" name="name" defaultValue={name ?? ''} required autoFocus />
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
      {pending ? 'Setting up…' : 'Accept invite'}
    </Button>
  );
}
