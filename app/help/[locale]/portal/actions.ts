'use server';

import { redirect } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { DEFAULT_LOCALE, isLocale, type Locale, type StringKey } from '@/lib/kb/locale';
import { appendReply, createTicket } from '@/lib/portal/tickets';
import { missingRequired } from '@/lib/tickets/custom-fields';
import { applyFieldValue } from '@/lib/tickets/custom-fields-parse';
import { customerTicketFields } from '@/lib/portal/fields';
import { text } from '@/lib/http/form-data';

/**
 * What a signed-in customer can do to their own tickets.
 *
 * The contact id comes from the session on every call and is never accepted
 * from the form. A hidden field carrying it would be a hidden field an attacker
 * can edit, and "reply to ticket 41 as contact X" is the whole ballgame.
 */
export type PortalTicketState = {
  error: StringKey | null;
  /**
   * Keys of the custom fields the customer left empty, so the form can mark
   * them rather than only saying that something is missing.
   *
   * The message itself stays a `StringKey` — a custom field's label is a single
   * admin-entered string with no per-locale variant, so naming the fields in the
   * error sentence would put an English label in an Arabic message. The labels
   * are already on screen beside their inputs; highlighting them there says the
   * same thing in whatever language they were written.
   */
  missing?: string[];
};

function localeOf(formData: FormData): Locale {
  const value = String(formData.get('locale') ?? '');
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function createPortalTicket(
  _state: PortalTicketState,
  formData: FormData,
): Promise<PortalTicketState> {
  const locale = localeOf(formData);
  const customer = await getSessionCustomer();
  if (!customer) redirect(`/${locale}/account/login`);

  const subject = text(formData, 'subject');
  const body = text(formData, 'body');

  if (!subject) return { error: 'errorSubjectRequired' };
  if (!body) return { error: 'errorMessageRequired' };

  // Read from the database, never from the form: the submitted keys say which
  // answers were given, and the definitions say which fields exist, what type
  // each is and whether a customer may write to it at all. Trusting the form for
  // that would let anybody set any key on their own ticket, including one an
  // automation routes on.
  const fields = await customerTicketFields();

  let customFields: Record<string, unknown> = {};
  for (const field of fields) {
    const raw =
      field.type === 'multi_select'
        ? formData.getAll(`custom.${field.key}`).map(String)
        : String(formData.get(`custom.${field.key}`) ?? '');

    const applied = applyFieldValue(customFields, field, raw);
    // A value the parser refuses is treated as unanswered rather than as an
    // error of its own: the inputs are typed, so the only way to get here is a
    // hand-made request, and a required field will catch it on the next line.
    if (applied.ok) customFields = applied.values;
  }

  const missing = missingRequired(fields, customFields, 'create');
  if (missing.length) {
    return { error: 'errorMissingFields', missing: missing.map((field) => field.key) };
  }

  const created = await createTicket(customer.contactId, { subject, body, customFields });

  redirect(`/${locale}/portal/t/${created.number}?created=1`);
}

export async function replyToPortalTicket(
  _state: PortalTicketState,
  formData: FormData,
): Promise<PortalTicketState> {
  const locale = localeOf(formData);
  const customer = await getSessionCustomer();
  if (!customer) redirect(`/${locale}/account/login`);

  const number = Number(formData.get('number'));
  const body = text(formData, 'body');

  if (!Number.isInteger(number)) return { error: 'errorGeneric' };
  if (!body) return { error: 'errorMessageRequired' };

  const result = await appendReply(customer.contactId, number, body);
  // A ticket that is not theirs and a ticket that is closed both land here, and
  // both get the same answer: nothing about the ticket, including whether it
  // exists.
  if (!result.ok) return { error: 'errorGeneric' };

  // A redirect rather than a returned state. Returning would re-render the
  // client component with the reply still sitting in the textarea and the
  // server-rendered thread above it unchanged, so the message the customer just
  // sent would appear to have vanished. It also means a browser refresh re-reads
  // the thread instead of re-posting the reply.
  redirect(`/${locale}/portal/t/${number}?replied=1`);
}
