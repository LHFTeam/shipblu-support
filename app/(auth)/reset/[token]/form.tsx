'use client';

import { resetPassword, type AuthFormState } from '../../actions';
import { ErrorText, Input, Label } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AuthFormState = { error: null };

export function ResetForm({ token, email }: { token: string; email: string }) {
  const { state, form } = useActionForm(resetPassword, INITIAL);

  return (
    <form {...form} className="flex flex-col gap-3.5">
      <input type="hidden" name="token" value={token} />

      <p className="text-sm text-(--color-text-secondary)">
        Choose a new password. You will be signed out everywhere and asked to sign in with it.
      </p>

      <div>
        <Label htmlFor="email">Email</Label>
        {/*
          No `name`, as on the invite form: the account is the link's, and the
          server reads nothing from here. It is drawn so a password manager
          files the new password under the right account.
        */}
        <Input id="email" type="email" defaultValue={email} readOnly autoComplete="username" />
      </div>

      <div>
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          autoFocus
        />
        <p className="mt-1 text-xs text-(--color-text-secondary)">At least 12 characters.</p>
      </div>

      <ErrorText>{state.error}</ErrorText>

      <SubmitButton idle="Change password" busy="Changing…" className="w-full" />
    </form>
  );
}
