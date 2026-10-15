import Link from 'next/link';
import { notFound } from 'next/navigation';
import { buttonClass } from '@/components/ui';
import { formatArticleDate } from '@/lib/kb/dates';
import { isLocale, t } from '@/lib/kb/locale';
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
          /*
            One card holding every ticket as a row, rather than a card per
            ticket lifting on hover: a shadow is for something that floats, and
            a list of the same thing reads faster as one list.
          */
          <Panel as="section" className="overflow-hidden">
            <ul>
              {tickets.map((ticket) => (
                <li
                  key={ticket.number}
                  className="border-b border-(--color-border-subtle) last:border-0"
                >
                  <Link
                    href={`/${locale}/portal/t/${ticket.number}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3.5 transition-colors hover:bg-(--color-background-surface-sunken)"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-bold text-(--color-text-primary)">
                        {ticket.subject ?? '—'}
                      </span>
                      <span className="mt-0.5 block text-xs text-(--color-text-secondary) tabular-nums">
                        #{ticket.number} · {t(locale, 'ticketUpdated')}:{' '}
                        {formatArticleDate(locale, ticket.lastMessageAt)}
                      </span>
                    </span>
                    <StatusBadge
                      locale={locale}
                      label={ticket.statusLabel}
                      category={ticket.statusCategory}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
          <p className="text-sm text-(--color-text-secondary)">{t(locale, 'searchKb')}</p>
          <Link href={`/${locale}/forms`} className={`sm:ms-auto ${buttonClass()}`}>
            {t(locale, 'openTicket')}
          </Link>
        </Panel>
      </PageBody>
    </>
  );
}
