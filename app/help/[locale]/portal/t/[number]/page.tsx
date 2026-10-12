import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ShipBluLogo } from '@/components/brand';
import { ChatBubble } from '@/components/chat';
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
  searchParams: Promise<{ created?: string; replied?: string; files?: string }>;
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

  const { created, replied, files } = await searchParams;

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
        meta={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="tabular-nums">#{ticket.number}</span>
            <StatusBadge
              locale={locale}
              label={ticket.statusLabel}
              category={ticket.statusCategory}
            />
          </span>
        }
      />

      <PageBody>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          <p className="text-sm">
            <Link
              href={`/${locale}/portal`}
              className="text-(--color-text-link) underline underline-offset-4 hover:text-(--color-text-link-hover)"
            >
              {t(locale, 'backToTickets')}
            </Link>
          </p>

          {created === '1' || replied === '1' ? (
            <SuccessText>
              {created === '1' ? t(locale, 'ticketCreated') : t(locale, 'replySent')}
            </SuccessText>
          ) : null}

          {/* The agent is told by a system message on the ticket; without this
              the customer was not told at all, and was looking at a receipt for
              a ticket missing the photo it is about. */}
          {files === 'failed' ? (
            <p className="text-sm text-(--color-feedback-danger-fg)">
              {t(locale, 'formAttachmentFailed')}
            </p>
          ) : null}

          {/*
            Drawn as a conversation from where the customer sits: their own
            messages on the end side in blue, ours on the start side under the
            ShipBlu mark — the same layout as the chat in the corner, so a
            customer who has used one can read the other. Every bubble keeps
            its own author and date, rather than folding a run under one, because
            a ticket's replies can be days apart.
          */}
          <Panel className="p-5">
            <ol className="flex flex-col">
              {ticket.messages.map((message) => {
                const mine = message.from === 'customer';
                return (
                  <ChatBubble
                    key={message.id}
                    from={mine ? 'out' : 'in'}
                    author={
                      mine ? t(locale, 'you') : (message.authorName ?? t(locale, 'supportTeam'))
                    }
                    avatar={mine ? undefined : <ShipBluLogo className="size-7" />}
                    time={
                      <time dateTime={message.createdAt.toISOString()}>
                        {formatArticleDate(locale, message.createdAt)}
                      </time>
                    }
                  >
                    {/* Plain text, rendered as text. An agent's reply can contain
                        HTML the customer's own words never should, and one
                        renderer for both is one XSS sink for both. */}
                    <p className="whitespace-pre-wrap">{message.body}</p>
                  </ChatBubble>
                );
              })}
            </ol>
          </Panel>

          {ticket.canReply ? (
            <Panel className="p-4">
              <ReplyBox locale={locale} number={ticket.number} />
            </Panel>
          ) : (
            <p className="text-sm">
              <Link
                href={`/${locale}/forms`}
                className="text-(--color-text-link) underline underline-offset-4 hover:text-(--color-text-link-hover)"
              >
                {t(locale, 'openTicket')}
              </Link>
            </p>
          )}
        </div>
      </PageBody>
    </>
  );
}
