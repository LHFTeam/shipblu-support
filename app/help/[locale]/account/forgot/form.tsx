'use client';

import { ErrorText, Input, Label } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { portalForgotPassword, type PortalFormState } from '../actions';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: PortalFormState = { error: null };

export function ForgotForm({ locale }: { locale: Locale }) {
  const { state, form } = useActionForm(portalForgotPassword, INITIAL, 'errorNoAnswer');

  if (state.done) {
    return (
      <div className="text-sm">
        <p className="font-medium">{t(locale, 'checkYourEmail')}</p>
        <p className="mt-1 opacity-70">{t(locale, 'resetSent')}</p>
      </div>
    );
  }

  return (
    <form action={form.action} onSubmit={form.onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />

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

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <SubmitButton className="w-full" idle={t(locale, 'send')} busy={t(locale, 'submitting')} />
    </form>
  );
}
