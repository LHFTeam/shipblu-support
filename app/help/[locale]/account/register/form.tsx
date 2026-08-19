'use client';

import { useActionState } from 'react';
import { ErrorText, Input, Label } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { portalRegister, type PortalFormState } from '../actions';
import { SubmitButton } from '../submit';

const INITIAL: PortalFormState = { error: null };

export function RegisterForm({ locale }: { locale: Locale }) {
  const [state, action] = useActionState(portalRegister, INITIAL);

  // Deliberately the same panel whether the address was new, already had an
  // account, or was throttled. The customer's next step is identical in all
  // three — open the email — and any other wording would answer "does this
  // person have a ShipBlu account?" for anyone who cared to ask.
  if (state.done) {
    return (
      <div className="text-sm">
        <p className="font-medium">{t(locale, 'checkYourEmail')}</p>
        <p className="mt-1 opacity-70">{t(locale, 'verificationSent')}</p>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />

      <div>
        <Label htmlFor="name">{t(locale, 'name')}</Label>
        <Input id="name" name="name" autoComplete="name" />
      </div>

      <div>
        <Label htmlFor="email">{t(locale, 'email')}</Label>
        <Input id="email" name="email" type="email" dir="ltr" autoComplete="username" required />
      </div>

      <div>
        <Label htmlFor="password">{t(locale, 'password')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <p className="mt-1 text-xs opacity-60">{t(locale, 'errorPasswordShort')}</p>
      </div>

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <SubmitButton idle={t(locale, 'createAccount')} busy={t(locale, 'submitting')} />
    </form>
  );
}
