import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatArticleDate, isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { listTickets } from '@/lib/portal/tickets';
import { EmptyNote, PageBody, PageHeader, Panel } from '../chrome';
import { StatusBadge } from './status';

export const dynamic = 'force-dynamic';

export default async function PortalHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const customer = await requireCustomer(locale, `/${locale}/portal`);
  const tickets = await listTickets(customer.contactId);

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[{ label: t(locale, 'home'), href: `/${locale}` }]}
        title={t(locale, 'myTickets')}
        selfPath={`/${locale}/portal`}
        meta={t(locale, 'myTicketsIntro')}
      />

      <PageBody>
        {tickets.length === 0 ? (
          <EmptyNote>{t(locale, 'noTickets')}</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-3">
            {tickets.map((ticket) => (
              <li key={ticket.number}>
                <Link
                  href={`/${locale}/portal/t/${ticket.number}`}
                  className="kb-panel flex flex-wrap items-center gap-x-3 gap-y-2 p-4 transition-[box-shadow,border-color] hover:border-[var(--kb-border-strong)] hover:shadow-lg"
                >
                  <span className="font-mono text-xs text-[var(--kb-muted)]">#{ticket.number}</span>
                  <span className="min-w-0 flex-1 font-medium text-[var(--kb-heading)]">
                    {ticket.subject ?? '—'}
                  </span>
                  <StatusBadge
                    locale={locale}
                    label={ticket.statusLabel}
                    category={ticket.statusCategory}
                  />
                  <span className="text-xs text-[var(--kb-muted)]">
                    {t(locale, 'ticketUpdated')}: {formatArticleDate(locale, ticket.lastMessageAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <Panel className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
          <p className="text-sm text-[var(--kb-muted)]">{t(locale, 'searchKb')}</p>
          <Link
            href={`/${locale}/portal/new`}
            className="sm:ms-auto rounded-md bg-[var(--button-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
          >
            {t(locale, 'openTicket')}
          </Link>
        </Panel>
      </PageBody>
    </>
  );
}
