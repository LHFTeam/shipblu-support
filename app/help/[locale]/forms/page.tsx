import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSessionCustomer } from '@/lib/auth/customer-session';
import { formPath } from '@/lib/forms/naming';
import { formDescription, formName, listForms } from '@/lib/forms/queries';
import { isLocale, t } from '@/lib/kb/locale';
import { PageBody, PageHeader, Panel } from '../chrome';

export const dynamic = 'force-dynamic';

/**
 * Which form to fill in.
 *
 * On an installation with no forms this redirects to the older `/portal/new`,
 * which asks for a subject, a message and every customer-writable field. That
 * is not a transitional nicety: without it, adding this page would take away
 * the only way to open a ticket from the help centre until somebody built a
 * form, and the redirect back the other way in `/portal/new` is what makes the
 * pair a single door rather than two.
 */
export default async function FormsIndex({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  /** Passed straight through, so a link from the tracking page keeps its number. */
  searchParams: Promise<{ subject?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const forms = await listForms('help_centre');
  const subject = (query.subject ?? '').trim().slice(0, 200);
  const suffix = subject ? `?subject=${encodeURIComponent(subject)}` : '';

  if (forms.length === 0) redirect(`/${locale}/portal/new${suffix}`);
  if (forms.length === 1) redirect(formPath(locale, forms[0]!.slug, suffix));

  const customer = await getSessionCustomer();

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
        title={t(locale, 'formsTitle')}
        selfPath={`/${locale}/forms`}
        meta={t(locale, 'formsIntro')}
      />

      <PageBody>
        <div className="mx-auto w-full max-w-2xl">
          <Panel as="section" className="overflow-hidden">
            <ul>
              {forms.map((form) => {
                const description = formDescription(form, locale);

                return (
                  <li
                    key={form.id}
                    className="border-b border-(--color-border-subtle) last:border-0"
                  >
                    <Link
                      href={formPath(locale, form.slug, suffix)}
                      className="block px-4 py-3.5 transition-colors hover:bg-(--color-background-surface-sunken)"
                    >
                      <span className="text-base font-bold text-(--color-text-primary)">
                        {formName(form, locale)}
                      </span>
                      {description ? (
                        <span className="mt-0.5 block text-sm text-(--color-text-secondary)">
                          {description}
                        </span>
                      ) : null}
                      {/* Said here rather than after the click: being sent to a
                          sign-in screen by a link that promised a form is the
                          moment a customer gives up and writes to the mailbox. */}
                      {form.requiresSignIn && !customer ? (
                        <span className="mt-1 block text-xs text-(--color-text-secondary)">
                          {t(locale, 'formSignInNeeded')}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <p className="mt-4 text-sm text-(--color-text-secondary)">{t(locale, 'searchKb')}</p>
        </div>
      </PageBody>
    </>
  );
}
