import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { groups, ticketFields, ticketForms } from '@/db/schema';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { parseFormElements } from '@/lib/forms/elements';
import { listAllTicketFields } from '@/lib/tickets/queries';
import { FormEditor, NewForm } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Ticket forms.
 *
 * The list is shown in the order the help centre offers them, which is the
 * order a customer choosing between "damaged parcel" and "general enquiry"
 * reads — so an admin arranging it can see what that choice will look like.
 */
export default async function FormsPage() {
  await requirePermission('admin.forms');

  const [forms, groupList, fieldList, defs] = await Promise.all([
    db.select().from(ticketForms).orderBy(asc(ticketForms.position), asc(ticketForms.slug)),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name)),
    // Retired fields included, marked. A form can already be placing one, and
    // leaving it out of the picker renders that row blank with no way to tell
    // which question it is — while every save re-posts it.
    db
      .select({
        key: ticketFields.key,
        label: ticketFields.label,
        type: ticketFields.type,
        options: ticketFields.options,
        visibleToCustomer: ticketFields.visibleToCustomer,
        editableByCustomer: ticketFields.editableByCustomer,
        isActive: ticketFields.isActive,
      })
      .from(ticketFields)
      .orderBy(asc(ticketFields.position), asc(ticketFields.label)),
    listAllTicketFields(),
  ]);

  const groupChoices = groupList.map((group) => ({ value: group.id, label: group.name }));
  const fieldChoices = fieldList.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options.map((option) => ({ value: option.value, label: option.label })),
    internal: !(field.visibleToCustomer && field.editableByCustomer),
    retired: !field.isActive,
  }));

  return (
    <>
      <PageHeader
        title="Forms"
        description="Named sets of questions that open a ticket. A form decides what is asked, what is asked only when something else was answered, and which queue the answers land in."
        actions={
          <NewForm groups={groupChoices} fields={fieldChoices} nextPosition={forms.length + 1} />
        }
      />

      <div className="flex flex-col gap-3">
        {forms.map((form) => (
          <Card key={form.id}>
            <FormEditor
              form={form}
              groups={groupChoices}
              fields={fieldChoices}
              // Parsed, not the raw document length. The count is the only
              // signal on this screen that a form has drifted from what was
              // built, and the stored length is the one number that cannot show
              // the drift.
              questionCount={parseFormElements(form.elements, defs).length}
            />
          </Card>
        ))}
      </div>

      {forms.length === 0 ? (
        <EmptyState
          title="No forms yet"
          hint="Until there is one, the help centre’s “contact support” link asks for a subject and a message and nothing else."
        />
      ) : null}
    </>
  );
}
