'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Avatar } from '@/components/avatar';
import { ChannelBadge } from '@/components/channel';
import { ChevronLeftIcon } from '@/components/icons';
import { RelativeTime } from '@/components/relative-time';
import { Badge } from '@/components/ui';
import { ago } from '@/lib/format';
import { answeredFromConsole, isCommentTicket, isMetaChannel } from '@/lib/tickets/channel-policy';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { ProfileRefresh } from './profile-refresh';
import { MetaWindowIndicator, WindowIndicator } from './window-indicator';

export function Header({
  conversation,
  canEditContact,
  canViewContact,
}: {
  conversation: ConversationDetail;
  canEditContact: boolean;
  canViewContact: boolean;
}) {
  const isMeta = isMetaChannel(conversation.channel);
  const isComment = isCommentTicket(conversation.channel, conversation.externalId);

  // The filters live in the query string, and the rows link forward carrying it,
  // so the way back has to carry it too. A bare `/inbox` reset the list to "all
  // channels" — and on a restricted channel that is worse than losing a filter:
  // the customer bot is absent from "all channels" by design, so going back from
  // one of its transcripts emptied the list of the very conversation the agent
  // had just been reading.
  const search = useSearchParams().toString();

  const whatsappWindow =
    conversation.channel === 'whatsapp' && answeredFromConsole(conversation.channel);
  const metaWindow = isMeta && !isComment;
  const canRefreshProfile = isMeta && !isComment && canEditContact;
  const handle = conversation.requester.email ?? conversation.requester.phone;

  return (
    <header className="flex min-h-(--header-height) shrink-0 items-center gap-3 border-b border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2 md:px-5 md:py-2.5">
      {/* On a phone the list and the ticket are separate screens, so the
          ticket needs a way back. */}
      <Link
        href={search ? `/inbox?${search}` : '/inbox'}
        aria-label="Back to the inbox"
        className="-ms-1.5 inline-flex shrink-0 rounded-md p-1.5 text-(--color-text-secondary) hover:bg-(--color-background-hover) md:hidden"
      >
        <ChevronLeftIcon size={20} />
      </Link>

      <Avatar
        name={conversation.requester.name}
        contactId={conversation.requester.id}
        // The avatar route answers 404 without contact.view, so asking for the
        // picture then is a request that can only fail.
        hasAvatar={canViewContact && conversation.requester.hasAvatar}
        size={36}
      />

      <div className="min-w-0 flex-1">
        {/*
          The customer is the heading and the subject sits under it, as in any
          chat: on WhatsApp and Messenger the subject is a line we made up, and
          the person is what an agent recognises a ticket by. It stays on every
          width, truncated, because on an email or a portal ticket the subject is
          what the agent is answering.
        */}
        <div className="flex min-w-0 items-center gap-2">
          <h1 dir="auto" className="truncate text-base/6 font-semibold">
            {conversation.requester.name ?? 'Unknown'}
          </h1>
          <span className="inline-flex shrink-0 md:hidden">
            <ChannelBadge channel={conversation.channel} showLabel={false} />
          </span>
          <span className="hidden shrink-0 md:inline-flex">
            <ChannelBadge channel={conversation.channel} />
          </span>
          <span className="inline-flex shrink-0">
            <Badge tone={conversation.statusCategory}>{conversation.statusName}</Badge>
          </span>
        </div>

        <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-(--color-text-secondary)">
          {handle ? (
            <>
              {/* Weighted so a phone number (13 characters) always shows in
                  full and only a very long email is cut, while the subject keeps
                  at least the rest of the line — on a phone this is the one
                  place the requester's number or address is visible. */}
              <span dir="ltr" className="max-w-[55%] shrink-0 truncate">
                {handle}
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="shrink-0 tabular-nums">#{conversation.number}</span>
          <span aria-hidden>·</span>
          <span dir="auto" className="min-w-0 truncate">
            {conversation.subject ?? '(no subject)'}
          </span>
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-(--color-text-secondary)">
          <RelativeTime at={conversation.createdAt}>
            {(relative) => <span>Opened {ago(relative)}</span>}
          </RelativeTime>
          {isComment ? <Badge tone="public">Public comment</Badge> : null}
          {conversation.businessNumber ? (
            <BusinessNumberBadge number={conversation.businessNumber} />
          ) : null}
          {/*
              Only where there is something to ask. A Messenger or Instagram
              customer arrives as a bare scoped id and stays unnamed until Meta
              answers; every other channel already knows who wrote in, so a
              button offering to find out would be a control that can only
              disappoint. Comment tickets are excluded for a sharper reason: a
              comment author's id is not the page-scoped id the User Profile API
              answers for, so the call is refused in a way indistinguishable from
              a missing approval — the one signal here that has to stay
              trustworthy.
            */}
          {canRefreshProfile ? (
            <ProfileRefresh
              conversationId={conversation.id}
              hasName={conversation.requester.name !== null}
            />
          ) : null}
          {conversation.reopenCount > 0 ? (
            <Badge tone="warning">Reopened ×{conversation.reopenCount}</Badge>
          ) : null}
          {conversation.formName ? <Badge tone="brand">{conversation.formName}</Badge> : null}
          {/*
              Nobody proved who sent this. A form that anybody can submit
              resolves the address it was given onto whatever contact already
              owns it — which is what makes the unified inbox real, and is also
              why a stranger can file a ticket under a real customer's name. The
              mail channel has SPF and DKIM behind it; a web form has nothing, so
              the ticket says so and the agent reads it differently.
            */}
          {conversation.unverifiedSubmitter ? (
            <Badge tone="warning">Not signed in — sender unverified</Badge>
          ) : null}
          {/* The 24-hour window only bounds a reply sent from here, so on a
                channel not answered from here the countdown measures nothing. */}
          {whatsappWindow ? (
            <WindowIndicator lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
          ) : null}
          {metaWindow ? (
            <MetaWindowIndicator
              lastCustomerMessageAt={conversation.lastCustomerMessageAt}
              thread={conversation.metaThread}
            />
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * Which of our WhatsApp numbers the customer wrote to.
 *
 * Here and not only in the sidebar, because the sidebar is desktop-only and
 * this is the one thing that tells a customer's two tickets apart — one per
 * number they wrote to — on the phone the owner of a number answers from.
 *
 * The name gives way and the number does not: at phone width the whole
 * sentence is wider than the row, and a cut-off "+20 12 787…" is no longer a
 * number anybody can check against their phone. The wrapper caps the badge at
 * the row's width so the name has something to truncate against, and gives
 * the badge itself `min-width: 0` (`*:`), because a flex item will not shrink
 * below its content without it and `Badge` takes no class of its own. The name is
 * isolated with `dir="auto"`, since a channel is often named after the person
 * it belongs to and that can be Arabic; the number is `dir="ltr"`, so its
 * digit groups stay in order whatever is around them.
 */
function BusinessNumberBadge({
  number,
}: {
  number: NonNullable<ConversationDetail['businessNumber']>;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 *:min-w-0">
      <Badge>
        <span className="min-w-0 truncate">
          Our number: <span dir="auto">{number.name}</span>
        </span>
        {number.displayNumber ? (
          <span dir="ltr" className="shrink-0 tabular-nums">
            ({number.displayNumber})
          </span>
        ) : null}
      </Badge>
    </span>
  );
}
