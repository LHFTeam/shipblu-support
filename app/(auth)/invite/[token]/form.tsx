'use client';

import { acceptInvite, type AuthFormState } from '../../actions';
import { ErrorText, Input, Label } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: AuthFormState = { error: null };

/**
 * Activation: the identity comes from the invite, and the password is the only
 * thing the invitee supplies.
 *
 * Both identity fields are rendered filled in rather than as prose, because
 * "here is who we think you are, confirm it by setting a password" is what this
 * page is doing, and a sentence of body text does not read as a form somebody
 * has already half-completed for you.
 *
 * There is no unnamed-invite branch to handle: `invites.name` is NOT NULL, so
 * the admin has already answered the only identity question this page could
 * otherwise have had to ask.
 */
export function InviteForm({ token, email, name }: { token: string; email: string; name: string }) {
  const { state, form } = useActionForm(acceptInvite, INITIAL);

  return (
    <form {...form} className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6">
      <input type="hidden" name="token" value={token} />

      <p className="text-sm opacity-70">Set a password to activate your account.</p>

      <div>
        <Label htmlFor="email">Email</Label>
        {/*
          Deliberately has no `name`, so nothing is submitted. The address is
          fixed by the invite and `acceptInvite` reads it off the row it looked
          the token up on — this field exists to show the invitee which of their
          addresses was invited, and posting a value the server is required to
          ignore only invites a later change to start trusting it.
        */}
        <Input id="email" type="email" defaultValue={email} readOnly autoComplete="username" />
      </div>

      <div>
        <Label htmlFor="name">Your name</Label>
        {/*
          Prefilled and still editable. The admin typed this, so it is a
          reasonable guess rather than a fact about the person reading it, and
          the one moment somebody can correct a misspelling of their own name is
          before the account carries it into every ticket they ever answer.
        */}
        <Input id="name" name="name" defaultValue={name} required autoComplete="name" />
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
          // The only field with anything left to do in it. Focusing the
          // prefilled name instead puts the cursor in a box the page has just
          // told them they can leave alone.
          autoFocus
        />
        <p className="mt-1 text-xs opacity-50">At least 12 characters.</p>
      </div>

      <ErrorText>{state.error}</ErrorText>

      {/* Matches the call to action in the invitation email, so the button the
          invitee arrives looking for is the one on the page. */}
      <SubmitButton idle="Activate my account" busy="Activating…" className="w-full" />
    </form>
  );
}
