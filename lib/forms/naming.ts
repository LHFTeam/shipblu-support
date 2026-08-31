import { localised } from '@/lib/tickets/custom-fields';

/**
 * What a form is called, wherever it is named.
 *
 * Its own module, and not beside the queries, because `lib/tickets/queries.ts`
 * needs it to put a form's name on a ticket while `lib/forms/queries.ts` needs
 * `listTicketFields` from there — the two importing each other is a cycle whose
 * failure mode is an undefined function at runtime rather than an error at
 * build time. Nothing here touches the database, so both sides can have it.
 */

/** The form's own name, in the reader's language. */
export function formName(
  form: { nameAr: string; nameEn: string; slug: string },
  locale: 'ar' | 'en',
): string {
  // A blank fallback on purpose: the slug is a URL segment, not wording, so a
  // form named only in Arabic should read in Arabic to an English visitor
  // rather than as `damaged-parcel`.
  return localised(form.nameAr, form.nameEn, locale, '') || form.slug;
}

export function formDescription(
  form: { descriptionAr: string; descriptionEn: string },
  locale: 'ar' | 'en',
): string {
  return localised(form.descriptionAr, form.descriptionEn, locale, '');
}

export function formConfirmation(
  form: { confirmationAr: string; confirmationEn: string },
  locale: 'ar' | 'en',
): string {
  return localised(form.confirmationAr, form.confirmationEn, locale, '');
}
