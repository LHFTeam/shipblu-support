import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SuccessText } from '@/components/ui';
import { formatArticleDate, isLocale, t } from '@/lib/kb/locale';
import { requireCustomer } from '@/lib/portal/guard';
import { getTicket } from '@/lib/portal/tickets';
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
    <div className="mx-auto w-full max-w-2xl">
      <p className="text-sm">
        <Link href={`/${locale}/portal`} className="underline underline-offset-4 opacity-70">
          {t(locale, 'backToTickets')}
        </Link>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{ticket.subject ?? `#${ticket.number}`}</h1>
        <StatusBadge locale={locale} label={ticket.statusLabel} category={ticket.statusCategory} />
        <span className="font-mono text-xs opacity-50">#{ticket.number}</span>
      </div>

      {created === '1' || replied === '1' ? (
        <div className="mt-4">
          <SuccessText>
            {created === '1' ? t(locale, 'ticketCreated') : t(locale, 'replySent')}
          </SuccessText>
        </div>
      ) : null}

      <ol className="mt-6 flex flex-col gap-3">
        {ticket.messages.map((message) => (
          <li
            key={message.id}
            className={`rounded-lg border border-[var(--border)] p-4 ${
              message.from === 'customer' ? 'bg-[var(--muted)]/50' : ''
            }`}
          >
            <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs opacity-60">
              <span className="font-medium">
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
          </li>
        ))}
      </ol>

      <div className="mt-6">
        {ticket.canReply ? (
          <ReplyBox locale={locale} number={ticket.number} />
        ) : (
          <p className="text-sm opacity-60">
            <Link href={`/${locale}/portal/new`} className="underline underline-offset-4">
              {t(locale, 'openTicket')}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
