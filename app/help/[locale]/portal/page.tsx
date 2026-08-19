import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui';
import { formatArticleDate, isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { listTickets } from '@/lib/portal/tickets';
import { StatusBadge } from './status';

export const dynamic = 'force-dynamic';

export default async function PortalHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const customer = await requireCustomer(locale, `/${locale}/portal`);
  const tickets = await listTickets(customer.contactId);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t(locale, 'myTickets')}</h1>
          <p className="mt-1 text-sm opacity-70">{t(locale, 'myTicketsIntro')}</p>
        </div>
        <Link href={`/${locale}/portal/new`} className="ms-auto">
          <Button variant="accent">{t(locale, 'openTicket')}</Button>
        </Link>
      </div>

      {tickets.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] p-6 text-sm opacity-70">
          {t(locale, 'noTickets')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tickets.map((ticket) => (
            <li key={ticket.number}>
              <Link
                href={`/${locale}/portal/t/${ticket.number}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] p-4 transition-colors hover:bg-[var(--muted)]"
              >
                <span className="font-mono text-xs opacity-50">#{ticket.number}</span>
                <span className="min-w-0 flex-1 font-medium">{ticket.subject ?? '—'}</span>
                <StatusBadge
                  locale={locale}
                  label={ticket.statusLabel}
                  category={ticket.statusCategory}
                />
                <span className="text-xs opacity-50">
                  {t(locale, 'ticketUpdated')}: {formatArticleDate(locale, ticket.lastMessageAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
