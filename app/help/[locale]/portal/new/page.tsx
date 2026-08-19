import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { NewTicketForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewPortalTicket({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  await requireCustomer(locale, `/${locale}/portal/new`);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-semibold">{t(locale, 'newTicketTitle')}</h1>
      <p className="mt-1 text-sm opacity-70">{t(locale, 'newTicketIntro')}</p>
      {/* Nudged before the form rather than after it: a customer who finds the
          answer here costs the team nothing, and after the Send button is too
          late to be a suggestion. */}
      <p className="mt-1 text-sm opacity-50">{t(locale, 'searchKb')}</p>

      <div className="mt-6 rounded-lg border border-[var(--border)] p-6">
        <NewTicketForm locale={locale} />
      </div>

      <p className="mt-4 text-sm">
        <Link href={`/${locale}/portal`} className="underline underline-offset-4">
          {t(locale, 'backToTickets')}
        </Link>
      </p>
    </div>
  );
}
