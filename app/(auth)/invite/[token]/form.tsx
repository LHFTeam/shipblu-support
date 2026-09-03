'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { acceptInvite, type AuthFormState } from '../../actions';
import { Button, ErrorText, Input, Label } from '@/components/ui';

const INITIAL: AuthFormState = { error: null };

/**
 * Activation: the identity comes from the invite, and the password is the only
 * thing the invitee supplies.
 *
 * Both identity fields are rendered filled in rather than as prose, because
 * "here is who we think you are, confirm it by setting a password" is what this
 * page is doing, and a sentence of body text does not read as a form somebody
 * has already half-completed for you.
 */
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

  // The admin may have invited an address without a name — it is optional on
  // their form — and the agent record needs one. So the field is prefilled and
  // left alone when we have it, and asked for when we do not; a read-only empty
  // name would end up naming the account after the email address, which is what
  // `acceptInvite` falls back to.
  const hasName = Boolean(name);

  return (
    <form
      action={action}
      className="flex flex-col gap-4 rounded-lg border border-[var(--border)] p-6"
    >
      <input type="hidden" name="token" value={token} />

      <p className="text-sm opacity-70">
        {hasName
          ? 'Set a password to activate your account.'
          : 'Confirm your name and set a password to activate your account.'}
      </p>

      <div>
        <Label htmlFor="email">Email</Label>
        {/*
          Deliberately has no `name`, so nothing is submitted. The address is
          fixed by the invite and `acceptInvite` reads it off the row it looked
          the token up on — this field exists to show the invitee which of their
          addresses was invited, and posting a value the server is required to
          ignore only invites a later change to start trusting it.
        */}
        <Input
          id="email"
          type="email"
          defaultValue={email}
          readOnly
          autoComplete="username"
          className="cursor-default bg-[var(--muted)] text-[var(--muted-foreground)]"
        />
      </div>

      <div>
        <Label htmlFor="name">Your name</Label>
        <Input
          id="name"
          name="name"
          defaultValue={name ?? ''}
          required
          autoComplete="name"
          autoFocus={!hasName}
        />
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
          // The one field with anything left to do in it, whenever the invite
          // carried a name. Focusing the prefilled name instead puts the cursor
          // in the box the page just told them they can leave alone.
          autoFocus={hasName}
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
      {/* Matches the call to action in the invitation email, so the button the
          invitee arrives looking for is the one on the page. */}
      {pending ? 'Activating…' : 'Activate my account'}
    </Button>
  );
}
