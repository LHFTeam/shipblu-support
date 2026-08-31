import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SuccessText } from '@/components/ui';
import { formatArticleDate, isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { getTicket } from '@/lib/portal/tickets';
import { PageBody, PageHeader, Panel } from '../../../chrome';
import { StatusBadge } from '../../status';
import { ReplyBox } from './reply';

export const dynamic = 'force-dynamic';

export default async function PortalTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; number: string }>;
  searchParams: Promise<{ created?: string; replied?: string }>;
}) {
  const { locale, number: rawNumber } = await params;
  if (!isLocale(locale)) notFound();

  const number = Number(rawNumber);
  if (!Number.isInteger(number) || number <= 0) notFound();

  const customer = await requireCustomer(locale, `/${locale}/portal/t/${number}`);
  const ticket = await getTicket(customer.contactId, number);

  // Someone else's ticket and a ticket that does not exist are the same 404.
  // Distinguishing them would turn the ticket numbers, which run in sequence,
  // into a way of counting our customers.
  if (!ticket) notFound();

  const { created, replied } = await searchParams;

  return (
    <>
      <PageHeader
        locale={locale}
        crumbs={[
          { label: t(locale, 'home'), href: `/${locale}` },
          { label: t(locale, 'myTickets'), href: `/${locale}/portal` },
        ]}
        title={ticket.subject ?? `#${ticket.number}`}
        selfPath={`/${locale}/portal/t/${ticket.number}`}
        meta={`#${ticket.number}`}
      />

      <PageBody>
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge
              locale={locale}
              label={ticket.statusLabel}
              category={ticket.statusCategory}
            />
            <Link
              href={`/${locale}/portal`}
              className="sm:ms-auto text-sm text-[var(--kb-link)] underline underline-offset-4"
            >
              {t(locale, 'backToTickets')}
            </Link>
          </div>

          {created === '1' || replied === '1' ? (
            <div className="mt-4">
              <SuccessText>
                {created === '1' ? t(locale, 'ticketCreated') : t(locale, 'replySent')}
              </SuccessText>
            </div>
          ) : null}

          <ol className="mt-5 flex flex-col gap-3">
            {ticket.messages.map((message) => (
              <li key={message.id}>
                <Panel
                  className={`p-4 ${message.from === 'customer' ? 'bg-[var(--kb-surface-2)]' : ''}`}
                >
                  <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs text-[var(--kb-muted)]">
                    <span className="font-semibold text-[var(--kb-heading)]">
                      {message.from === 'customer'
                        ? t(locale, 'you')
                        : (message.authorName ?? t(locale, 'supportTeam'))}
                    </span>
                    <span>{formatArticleDate(locale, message.createdAt)}</span>
                  </div>
                  {/* Plain text, rendered as text. An agent's reply can contain HTML
                      the customer's own words never should, and one renderer for both
                      is one XSS sink for both. */}
                  <p className="text-sm whitespace-pre-wrap">{message.body}</p>
                </Panel>
              </li>
            ))}
          </ol>

          <div className="mt-6">
            {ticket.canReply ? (
              <ReplyBox locale={locale} number={ticket.number} />
            ) : (
              <Link
                href={`/${locale}/forms`}
                className="text-sm text-[var(--kb-link)] underline underline-offset-4"
              >
                {t(locale, 'openTicket')}
              </Link>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}
