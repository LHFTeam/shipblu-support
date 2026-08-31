import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { listForms } from '@/lib/forms/queries';
import { isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { customerTicketFields } from '@/lib/portal/fields';
import { PageBody, PageHeader, Panel } from '../../chrome';
import { NewTicketForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewPortalTicket({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  /**
   * `subject` pre-fills the first field. The tracking page sends one so a
   * customer who has just looked a parcel up does not retype its number — and
   * the detector in `lib/shipments/detect.ts` then links the new ticket to that
   * shipment without anybody doing it by hand.
   *
   * It is a default value on an editable field, nothing more: the server reads
   * what was actually submitted, as `createPortalTicket` already does, so a
   * crafted link can seed a subject and can do nothing else.
   */
  searchParams: Promise<{ subject?: string }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const subject = (query.subject ?? '').trim().slice(0, 200);

  // Once an admin has built a form, that is the door. This page stays as the
  // answer to "what happens before anybody has built one" — deleting it would
  // mean a fresh installation has no way to open a ticket from the help centre
  // at all, and `/forms` redirects back here for exactly that case.
  const forms = await listForms('help_centre');
  if (forms.length) {
    redirect(`/${locale}/forms${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`);
  }

  await requireCustomer(locale, `/${locale}/portal/new`);

  const fields = await customerTicketFields();

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: t(locale, 'myTickets'), href: `/${locale}/portal` },
        ]}
        title={t(locale, 'newTicketTitle')}
        selfPath={`/${locale}/portal/new`}
        meta={t(locale, 'newTicketIntro')}
      />

      <PageBody>
        <div className="mx-auto w-full max-w-2xl">
          {/* Nudged before the form rather than after it: a customer who finds the
              answer here costs the team nothing, and after the Send button is too
              late to be a suggestion. */}
          <p className="text-sm text-[var(--kb-muted)]">{t(locale, 'searchKb')}</p>

          <Panel className="mt-4 p-6">
            <NewTicketForm locale={locale} fields={fields} subject={subject} />
          </Panel>

          <p className="mt-4 text-sm">
            <Link
              href={`/${locale}/portal`}
              className="text-[var(--kb-link)] underline underline-offset-4"
            >
              {t(locale, 'backToTickets')}
            </Link>
          </p>
        </div>
      </PageBody>
    </>
  );
}
