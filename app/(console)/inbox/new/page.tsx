import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { elementsFor } from '@/lib/forms/elements';
import { formDescription, formName, getFormBySlug, listForms } from '@/lib/forms/queries';
import { ConsoleTicketForm } from './form';

export const dynamic = 'force-dynamic';

/**
 * Opening a ticket on a customer's behalf.
 *
 * Always through a form, never a blank subject-and-body box. A ticket typed
 * freehand is one that answered none of the questions the same request would
 * have been asked on the help centre — so it carries no custom fields, matches
 * none of the automations written against them, and shows up in every report as
 * a hole. Making the agent pick a form is what keeps a phone call and a web
 * submission comparable.
 */
export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ form?: string }>;
}) {
  await requirePermission('ticket.create');

  const query = await searchParams;
  const forms = await listForms('console');

  if (forms.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No forms are offered to agents"
          hint="Build one under Settings → Forms, and tick “Offer it to agents”."
          action={
            <Link href="/admin/forms" className="text-sm text-brand-600 hover:underline">
              Settings → Forms
            </Link>
          }
        />
      </div>
    );
  }

  const slug = query.form ?? forms[0]!.slug;
  const loaded = await getFormBySlug(slug);

  if (!loaded || !loaded.form.isActive || !loaded.form.showInConsole) {
    return (
      <div className="p-6">
        <EmptyState title="That form is no longer available" />
      </div>
    );
  }

  const { form, fields } = loaded;
  const elements = elementsFor(form.elements, { audience: 'agent', anonymous: false }, fields);
  const description = formDescription(form, 'en');

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto w-full max-w-2xl">
        <PageHeader title="New ticket" description={description || undefined} />

        {forms.length > 1 ? (
          <nav aria-label="Which form" className="mb-4 flex flex-wrap gap-2">
            {forms.map((option) => (
              <Link
                key={option.id}
                href={`/inbox/new?form=${encodeURIComponent(option.slug)}`}
                aria-current={option.slug === slug ? 'page' : undefined}
                className={`rounded-full px-3 py-1 text-xs ${
                  option.slug === slug
                    ? 'bg-brand-600 font-medium text-white'
                    : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                {formName(option, 'en')}
              </Link>
            ))}
          </nav>
        ) : null}

        <Card>
          <ConsoleTicketForm slug={slug} elements={elements} fields={fields} />
        </Card>
      </div>
    </div>
  );
}
