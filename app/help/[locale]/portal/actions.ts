'use server';

import { redirect } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { DEFAULT_LOCALE, isLocale, type Locale, type StringKey } from '@/lib/kb/locale';
import { appendReply, createTicket } from '@/lib/portal/tickets';

/**
 * What a signed-in customer can do to their own tickets.
 *
 * The contact id comes from the session on every call and is never accepted
 * from the form. A hidden field carrying it would be a hidden field an attacker
 * can edit, and "reply to ticket 41 as contact X" is the whole ballgame.
 */
export type PortalTicketState = { error: StringKey | null };

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

  const subject = String(formData.get('subject') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();

  if (!subject) return { error: 'errorSubjectRequired' };
  if (!body) return { error: 'errorMessageRequired' };

  const number = await createTicket(customer.contactId, { subject, body });

  redirect(`/${locale}/portal/t/${number}?created=1`);
}

export async function replyToPortalTicket(
  _state: PortalTicketState,
  formData: FormData,
): Promise<PortalTicketState> {
  const locale = localeOf(formData);
  const customer = await getSessionCustomer();
  if (!customer) redirect(`/${locale}/account/login`);

  const number = Number(formData.get('number'));
  const body = String(formData.get('body') ?? '').trim();

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
