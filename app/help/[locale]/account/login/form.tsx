'use client';

import { useEffect, useRef } from 'react';
import { ErrorText, Input, Label, SuccessText } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { portalSignIn, type PortalFormState } from '../actions';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: PortalFormState = { error: null };

/**
 * One form for both populations. It does not ask whether you are a customer or
 * an agent, because the server can tell from the address and asking would make
 * every customer answer a question about our internal table layout.
 */
export function LoginForm({
  locale,
  next,
  justReset,
}: {
  locale: Locale;
  next?: string;
  justReset?: boolean;
}) {
  const { state, form } = useActionForm(portalSignIn, INITIAL);
  const password = useRef<HTMLInputElement>(null);

  // A refused sign-in keeps the address and empties the password, as React's
  // reset used to: a wrong password is usually a near miss of the right one,
  // and left in the box it can be revealed by whoever sits down next. Cleared
  // on the node rather than by a remount, so the caret stays where an Enter
  // left it; skipped for the initial state, which would wipe an autofill.
  useEffect(() => {
    if (state.error && password.current) password.current.value = '';
  }, [state]);

  return (
    <form action={form.action} onSubmit={form.onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {justReset ? <SuccessText>{t(locale, 'resetSuccess')}</SuccessText> : null}

      <div>
        <Label htmlFor="email">{t(locale, 'email')}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          dir="ltr"
          autoComplete="username"
          required
          autoFocus
        />
      </div>

      <div>
        <Label htmlFor="password">{t(locale, 'password')}</Label>
        <Input
          ref={password}
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <SubmitButton className="w-full" idle={t(locale, 'signIn')} busy={t(locale, 'signingIn')} />
    </form>
  );
}
