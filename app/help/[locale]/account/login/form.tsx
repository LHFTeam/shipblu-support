'use client';

import { useActionState } from 'react';
import { ErrorText, Input, Label, SuccessText } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { portalSignIn, type PortalFormState } from '../actions';
import { SubmitButton } from '../submit';

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
  const [state, action] = useActionState(portalSignIn, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
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
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <SubmitButton idle={t(locale, 'signIn')} busy={t(locale, 'signingIn')} />
    </form>
  );
}
