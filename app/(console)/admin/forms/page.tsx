import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { groups, ticketFields, ticketForms } from '@/db/schema';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
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

  const [forms, groupList, fieldList] = await Promise.all([
    db.select().from(ticketForms).orderBy(asc(ticketForms.position), asc(ticketForms.slug)),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name)),
    // Active only: a deactivated field is one an admin has retired, and offering
    // it here would let them place a question that `parseFormElements` then
    // drops on the way back out.
    db
      .select({
        key: ticketFields.key,
        label: ticketFields.label,
        type: ticketFields.type,
        options: ticketFields.options,
        visibleToCustomer: ticketFields.visibleToCustomer,
        editableByCustomer: ticketFields.editableByCustomer,
      })
      .from(ticketFields)
      .where(eq(ticketFields.isActive, true))
      .orderBy(asc(ticketFields.position), asc(ticketFields.label)),
  ]);

  const groupChoices = groupList.map((group) => ({ value: group.id, label: group.name }));
  const fieldChoices = fieldList.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options.map((option) => ({ value: option.value, label: option.label })),
    internal: !(field.visibleToCustomer && field.editableByCustomer),
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
              questionCount={form.elements.length}
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
