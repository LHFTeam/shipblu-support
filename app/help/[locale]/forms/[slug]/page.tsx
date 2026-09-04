import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { elementsFor } from '@/lib/forms/elements';
import { formPath } from '@/lib/forms/naming';
import { formConfirmation, formDescription, formName, getFormBySlug } from '@/lib/forms/queries';
import { decodeSlugParam } from '@/lib/kb/slug';
import { isLocale, t, tCount } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { PageBody, PageHeader, Panel } from '../../chrome';
import { TicketForm } from './form';

export const dynamic = 'force-dynamic';

export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ subject?: string; submitted?: string; files?: string }>;
}) {
  const [{ locale, slug: raw }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  // Next hands a dynamic segment over still percent-encoded, and an Arabic slug
  // is entirely percent-encoded.
  const slug = decodeSlugParam(raw);

  const loaded = await getFormBySlug(slug);
  if (!loaded || !loaded.form.isActive || !loaded.form.showOnHelpCentre) notFound();

  const { form, fields } = loaded;

  // Signing in is enforced before anything is rendered, not on submit: a
  // customer who fills in eleven questions and is then sent to a login screen
  // comes back to an empty form.
  const customer = form.requiresSignIn
    ? await requireCustomer(locale, formPath(locale, slug))
    : await getSessionCustomer();

  const submitted = Number(query.submitted);
  const name = formName(form, locale);
  const description = formDescription(form, locale);

  if (Number.isInteger(submitted) && submitted > 0) {
    const confirmation = formConfirmation(form, locale) || t(locale, 'formSubmitted');

    return (
      <>
        <PageHeader
          locale={locale}
          crumbs={[
            { label: t(locale, 'home'), href: `/${locale}` },
            { label: t(locale, 'formsTitle'), href: `/${locale}/forms` },
          ]}
          title={name}
          selfPath={formPath(locale, slug)}
        />

        <PageBody>
          <div className="mx-auto w-full max-w-2xl">
            <Panel className="p-6">
              <p className="font-medium text-[var(--kb-heading)]">{confirmation}</p>
              <p className="mt-2 text-sm">{tCount(locale, 'formTicketNumber', submitted)}</p>
              <p className="mt-1 text-sm text-[var(--kb-muted)]">
                {t(locale, 'formAnonymousNext')}
              </p>
              {query.files === 'failed' ? (
                <p className="mt-2 text-sm text-red-700">{t(locale, 'formAttachmentFailed')}</p>
              ) : null}
            </Panel>

            <p className="mt-4 text-sm">
              <Link
                href={`/${locale}`}
                className="text-[var(--kb-link)] underline underline-offset-4"
              >
                {t(locale, 'backToHelp')}
              </Link>
            </p>
          </div>
        </PageBody>
      </>
    );
  }

  const elements = elementsFor(
    form.elements,
    { audience: 'customer', anonymous: !customer },
    fields,
  );

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: t(locale, 'formsTitle'), href: `/${locale}/forms` },
        ]}
        title={name}
        selfPath={formPath(locale, slug)}
        meta={description || undefined}
      />

      <PageBody>
        <div className="mx-auto w-full max-w-2xl">
          {/* Before the form rather than after it: a customer who finds the
              answer here costs the team nothing, and past the Send button is too
              late to be a suggestion. */}
          <p className="text-sm text-[var(--kb-muted)]">{t(locale, 'searchKb')}</p>

          <Panel className="mt-4 p-6">
            <TicketForm
              locale={locale}
              slug={slug}
              elements={elements}
              fields={fields}
              subject={(query.subject ?? '').trim().slice(0, 200)}
            />
          </Panel>
        </div>
      </PageBody>
    </>
  );
}
