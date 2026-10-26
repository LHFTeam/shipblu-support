import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { toCategoryChoices } from '@/lib/categories/choices';
import { listCategories } from '@/lib/categories/queries';
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
  const agent = await requirePermission('ticket.create');

  const query = await searchParams;
  // The chooser is drawn only for an agent who may set a category — the same
  // permission as the ticket's own select — and the action refuses a value
  // from anybody else, so hiding it is not the only thing standing in the way.
  // The registry is read beside the forms, since neither waits on the other.
  const [forms, categoryRows] = await Promise.all([
    listForms('console'),
    can(agent, 'ticket.set_category') ? listCategories() : null,
  ]);

  if (forms.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          title="No forms are offered to agents"
          hint="Build one under Settings → Forms, and tick “Offer it to agents”."
          action={
            <Link
              href="/admin/forms"
              className="text-sm text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
            >
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

  const categories = categoryRows ? toCategoryChoices(categoryRows) : null;
  // Named only while active: creation leaves a retired default off, so the
  // chooser must not promise it.
  const defaultCategory =
    categories?.find((category) => category.id === form.defaultCategoryId && category.isActive) ??
    null;

  return (
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto w-full max-w-2xl">
        <PageHeader title="New ticket" description={description || undefined} />

        {forms.length > 1 ? (
          <nav aria-label="Which form" className="mb-4 flex flex-wrap gap-2">
            {forms.map((option) => (
              <Link
                key={option.id}
                href={`/inbox/new?form=${encodeURIComponent(option.slug)}`}
                aria-current={option.slug === slug ? 'page' : undefined}
                className="rounded-full bg-(--color-background-surface-sunken) px-3 py-1 text-xs text-(--color-text-secondary) hover:text-(--color-text-primary) aria-[current=page]:bg-(--color-background-selected) aria-[current=page]:font-semibold aria-[current=page]:text-(--color-text-brand)"
              >
                {formName(option, 'en')}
              </Link>
            ))}
          </nav>
        ) : null}

        <Card>
          <ConsoleTicketForm
            slug={slug}
            elements={elements}
            fields={fields}
            defaultPriority={form.defaultPriority}
            categories={categories}
            defaultCategoryLabel={defaultCategory?.labelEn ?? null}
          />
        </Card>
      </div>
    </div>
  );
}
