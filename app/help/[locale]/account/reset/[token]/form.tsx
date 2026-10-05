'use client';

import { ErrorText, Input, Label } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { portalResetPassword, type PortalFormState } from '../../actions';
import { SubmitButton } from '@/components/submit-button';
import { useActionForm } from '@/components/use-action-form';

const INITIAL: PortalFormState = { error: null };

export function ResetForm({ locale, token }: { locale: Locale; token: string }) {
  const { state, form } = useActionForm(portalResetPassword, INITIAL);

  return (
    <form action={form.action} onSubmit={form.onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="token" value={token} />

      <div>
        <Label htmlFor="password">{t(locale, 'newPassword')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          autoFocus
        />
        <p className="mt-1 text-xs opacity-60">{t(locale, 'errorPasswordShort')}</p>
      </div>

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <SubmitButton
        className="w-full"
        idle={t(locale, 'savePassword')}
        busy={t(locale, 'submitting')}
      />
    </form>
  );
}
