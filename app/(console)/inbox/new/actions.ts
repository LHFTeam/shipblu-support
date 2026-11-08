'use server';

import { redirect } from 'next/navigation';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { consoleCategoryChoice } from '@/lib/forms/category';
import { getFormBySlug } from '@/lib/forms/queries';
import { labelsFor, submitForm } from '@/lib/forms/submit';
import { DEFAULT_LOCALE } from '@/lib/kb/locale';
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

  // Before `submitForm`, which writes a new customer's contact together with
  // the ticket: a refusal has to come before that write, or it would leave a
  // contact behind for a ticket never opened.
  const category = await consoleCategoryChoice(
    text(formData, 'categoryId'),
    can(agent, 'ticket.set_category'),
  );
  if ('error' in category) return { error: category.error };

  // The address as typed rather than a contact, for the same reason:
  // `submitForm` checks it after its own refusals — a question left blank, an
  // answer a field refuses, a file it will not take — and a new customer's
  // contact is written in the transaction that opens the ticket, so neither a
  // refusal nor a ticket that fails to open leaves one behind. Checked there
  // and nowhere else, so the console and the help centre cannot come to
  // disagree about what an address is.
  const result = await submitForm({
    loaded,
    values: formData,
    requester: {
      kind: 'agent',
      email: text(formData, 'requesterEmail'),
      name: text(formData, 'requesterName') || null,
      agentId: agent.id,
      categoryId: category.categoryId,
    },
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
