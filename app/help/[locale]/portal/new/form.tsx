'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Textarea } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import { createPortalTicket, type PortalTicketState } from '../actions';

const INITIAL: PortalTicketState = { error: null };

export function NewTicketForm({ locale }: { locale: Locale }) {
  const [state, action] = useActionState(createPortalTicket, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />

      <div>
        <Label htmlFor="subject">{t(locale, 'subject')}</Label>
        <Input id="subject" name="subject" required autoFocus maxLength={200} />
      </div>

      <div>
        <Label htmlFor="body">{t(locale, 'message')}</Label>
        <Textarea id="body" name="body" rows={8} required />
      </div>

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <Submit locale={locale} />
    </form>
  );
}

function Submit({ locale }: { locale: Locale }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} className="self-start">
      {pending ? t(locale, 'submitting') : t(locale, 'createTicket')}
    </Button>
  );
}
