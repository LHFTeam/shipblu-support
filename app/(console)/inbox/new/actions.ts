'use server';

import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guard';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { getFormBySlug } from '@/lib/forms/queries';
import { labelsFor, submitForm } from '@/lib/forms/submit';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
import { resolveContact } from '@/lib/tickets/contacts';
import { text } from '@/lib/http/form-data';

/**
 * Opening a ticket for a customer who reached the team some other way.
 *
 * Somebody phones, or catches an agent on WhatsApp personally, and the answer
 * until now was that the ticket did not exist — every other path into this
 * helpdesk starts with the customer writing something. Filling a form in on
 * their behalf means the same questions get asked, the same fields are stored
 * and the same routing applies, rather than an agent typing a paragraph into a
 * ticket nobody can report on.
 */

export type ConsoleFormState = { error: string | null };

export async function createTicketFromForm(
  _state: ConsoleFormState,
  formData: FormData,
): Promise<ConsoleFormState> {
  const agent = await requirePermission('ticket.create');

  const slug = String(formData.get('slug') ?? '');
  const loaded = await getFormBySlug(slug);
  if (!loaded || !loaded.form.isActive || !loaded.form.showInConsole) {
    return { error: 'That form is no longer available' };
  }

  const email = normaliseEmail(String(formData.get('requesterEmail') ?? ''));
  if (!looksLikeEmail(email)) return { error: 'Enter the customer’s email address' };

  // Resolved the same way an inbound email is, so a ticket an agent opens joins
  // the customer's existing history rather than starting a second stranger with
  // the same address.
  const contact = await resolveContact({
    channel: 'email',
    identifier: email,
    displayName: text(formData, 'requesterName') || null,
  });

  const result = await submitForm({
    loaded,
    values: formData,
    requester: { kind: 'agent', contactId: contact.contactId, agentId: agent.id },
    // The console is English; the ticket's wording follows the form the agent is
    // reading, not the customer's own locale. Worth knowing rather than hiding:
    // the answers are stored by value and only the summary in the first message
    // is worded, so a customer replying in Arabic still reads their own answers
    // in the sidebar.
    locale: DEFAULT_LOCALE === 'ar' ? 'en' : DEFAULT_LOCALE,
  });

  if (!result.ok) {
    switch (result.reason) {
      case 'missing':
        return {
          error: `Fill in ${labelsFor(result.keys, loaded.fields, 'en').join(', ')}`,
        };
      case 'invalid':
        return {
          error: `Check ${labelsFor(result.keys, loaded.fields, 'en').join(', ')}`,
        };
      case 'requester':
        return { error: 'Enter the customer’s email address' };
      case 'files':
        return { error: 'That attachment could not be accepted' };
    }
  }

  redirect(`/inbox/${result.number}`);
}
