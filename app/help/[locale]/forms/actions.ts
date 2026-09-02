'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { formPath } from '@/lib/forms/naming';
import { getFormBySlug } from '@/lib/forms/queries';
import { submitForm } from '@/lib/forms/submit';
import { allow, clientIpFrom } from '@/lib/kb/rate-limit';
import { DEFAULT_LOCALE, isLocale, type Locale, type StringKey } from '@/lib/kb/locale';

/**
 * Submitting a ticket form from the help centre.
 *
 * Every decision that matters is re-made here from the database: which form
 * this is, whether it may be submitted without signing in, which questions it
 * asks, and — through `submitForm` — which of those questions this submission
 * was actually asked. The request supplies answers and a slug.
 */

export type FormSubmitState = {
  error: StringKey | null;
  /** Keys of the questions that were asked and left empty. */
  missing?: string[];
  /** Keys whose answer the field's own rules refused. */
  invalid?: string[];
};

function localeOf(formData: FormData): Locale {
  const value = String(formData.get('locale') ?? '');
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function submitTicketForm(
  _state: FormSubmitState,
  formData: FormData,
): Promise<FormSubmitState> {
  const locale = localeOf(formData);
  const slug = String(formData.get('slug') ?? '');

  // In memory and generous, like every other public endpoint here: a row per
  // rejected request would hand an attacker a cheaper way to hurt the database
  // than the form itself.
  const ip = clientIpFrom(await headers());
  if (!allow(`form-submit:${ip}`, 10, 60_000)) return { error: 'errorThrottled' };

  const loaded = await getFormBySlug(slug);
  // A form that is inactive or not offered here reads as one that does not
  // exist — the page would have said the same, and a live link to a retired
  // form should not still work because somebody kept the URL.
  if (!loaded || !loaded.form.isActive || !loaded.form.showOnHelpCentre) {
    return { error: 'errorGeneric' };
  }

  const customer = await getSessionCustomer();
  if (loaded.form.requiresSignIn && !customer) {
    redirect(`/${locale}/account/login?next=${encodeURIComponent(formPath(locale, slug))}`);
  }

  const result = await submitForm({
    loaded,
    values: formData,
    // A signed-in visitor is never treated as anonymous, even on a form that
    // allows it: the session is the identity we can prove, and preferring a
    // typed address over it would let a typo file the ticket against somebody
    // else's record.
    requester: customer
      ? { kind: 'session', contactId: customer.contactId }
      : { kind: 'anonymous', ip },
    locale,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'missing':
        return { error: 'errorMissingFields', missing: result.keys };
      case 'invalid':
        return { error: 'errorInvalidFields', invalid: result.keys };
      case 'requester':
        return { error: 'errorInvalidEmail' };
      case 'files':
        return {
          error:
            result.refusal.reason === 'too_many'
              ? 'errorTooManyFiles'
              : result.refusal.reason === 'type'
                ? 'errorFileType'
                : result.refusal.reason === 'too_large_total'
                  ? 'errorFilesTooLarge'
                  : 'errorFileTooLarge',
        };
    }
  }

  // A signed-in customer goes to the ticket itself, where they can already read
  // and reply to it. A visitor who is not has no portal to be sent to, so the
  // form's own page becomes the receipt.
  //
  // Both carry the attachment failure. Only the agent used to be told, through
  // the system message `submitForm` writes — which left the customer looking at
  // a confirmation for a ticket missing the photo it is about.
  const failed = result.attachmentsFailed.length ? '&files=failed' : '';

  if (customer) redirect(`/${locale}/portal/t/${result.number}?created=1${failed}`);

  redirect(formPath(locale, slug, `?submitted=${result.number}${failed}`));
}
