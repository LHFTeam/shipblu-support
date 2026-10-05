'use client';

import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Textarea } from '@/components/ui';
import { useActionForm } from '@/components/use-action-form';
import { t, type Locale } from '@/lib/kb/locale';
import { replyToPortalTicket, type PortalTicketState } from '../../actions';

const INITIAL: PortalTicketState = { error: null };

/**
 * A successful reply redirects rather than returning here, so this component
 * only ever renders the failure case. That is deliberate: the thread above it is
 * server-rendered, and a success path that stayed on the page would leave the
 * customer's own message missing from the conversation they just added it to.
 */
export function ReplyBox({ locale, number }: { locale: Locale; number: number }) {
  const { state, form } = useActionForm(replyToPortalTicket, INITIAL);

  return (
    <form action={form.action} onSubmit={form.onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="number" value={number} />

      <Textarea
        name="body"
        rows={4}
        required
        aria-label={t(locale, 'reply')}
        placeholder={t(locale, 'replyPlaceholder')}
      />

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <Submit locale={locale} />
    </form>
  );
}

function Submit({ locale }: { locale: Locale }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="self-start">
      {pending ? t(locale, 'submitting') : t(locale, 'reply')}
    </Button>
  );
}
