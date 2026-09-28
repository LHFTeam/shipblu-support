'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Avatar } from '@/components/avatar';
import { ChannelBadge } from '@/components/channel';
import { ChevronLeftIcon } from '@/components/icons';
import { Badge } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { ProfileRefresh } from './profile-refresh';
import { MetaWindowIndicator, WindowIndicator } from './window-indicator';

export function Header({
  conversation,
  canEditContact,
}: {
  conversation: ConversationDetail;
  canEditContact: boolean;
}) {
  const isMeta = conversation.channel === 'facebook' || conversation.channel === 'instagram';
  const isComment = Boolean(conversation.externalId?.includes(':comment:'));

  // The filters live in the query string, and the rows link forward carrying it,
  // so the way back has to carry it too. A bare `/inbox` reset the list to "all
  // channels" — and on a restricted channel that is worse than losing a filter:
  // the customer bot is absent from "all channels" by design, so going back from
  // one of its transcripts emptied the list of the very conversation the agent
  // had just been reading.
  const search = useSearchParams().toString();

  return (
    <header className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 md:px-4">
      <div className="flex items-center gap-2">
        {/* On a phone the list and the ticket are separate screens, so the
            ticket needs a way back. */}
        <Link
          href={search ? `/inbox?${search}` : '/inbox'}
          aria-label="Back to the inbox"
          className="-ms-1 rounded-md p-1 hover:bg-[var(--muted)] md:hidden"
        >
          <ChevronLeftIcon size={18} />
        </Link>

        <h1 className="truncate text-base font-semibold">
          {conversation.subject ?? '(no subject)'}
        </h1>
        <span className="shrink-0 text-sm text-[var(--muted-foreground)]">
          #{conversation.number}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
        <Badge tone={conversation.statusCategory}>{conversation.statusName}</Badge>
        <ChannelBadge channel={conversation.channel} />
        {isComment ? <Badge tone="warning">public comment</Badge> : null}
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar
            name={conversation.requester.name}
            contactId={conversation.requester.id}
            hasAvatar={conversation.requester.hasAvatar}
            size={20}
          />
          <span className="truncate">
            {conversation.requester.name ?? 'Unknown'}{' '}
            {conversation.requester.email ?? conversation.requester.phone ?? ''}
          </span>
        </span>
        {/*
          Only where there is something to ask. A Messenger or Instagram
          customer arrives as a bare scoped id and stays unnamed until Meta
          answers; every other channel already knows who wrote in, so a button
          offering to find out would be a control that can only disappoint.
          Comment tickets are excluded for a sharper reason: a comment author's
          id is not the page-scoped id the User Profile API answers for, so the
          call is refused in a way indistinguishable from a missing approval —
          the one signal here that has to stay trustworthy.
        */}
        {isMeta && !isComment && canEditContact ? (
          <ProfileRefresh
            conversationId={conversation.id}
            hasName={conversation.requester.name !== null}
          />
        ) : null}
        <span aria-hidden>·</span>
        <span>opened {formatRelative(conversation.createdAt)} ago</span>
        {conversation.reopenCount > 0 ? (
          <Badge tone="warning">reopened ×{conversation.reopenCount}</Badge>
        ) : null}
        {conversation.formName ? <Badge tone="brand">{conversation.formName}</Badge> : null}
        {/*
          Nobody proved who sent this. A form that anybody can submit resolves
          the address it was given onto whatever contact already owns it — which
          is what makes the unified inbox real, and is also why a stranger can
          file a ticket under a real customer's name. The mail channel has SPF
          and DKIM behind it; a web form has nothing, so the ticket says so and
          the agent reads it differently.
        */}
        {conversation.unverifiedSubmitter ? (
          <Badge tone="warning">not signed in — sender unverified</Badge>
        ) : null}
        {conversation.channel === 'whatsapp' ? (
          <WindowIndicator lastCustomerMessageAt={conversation.lastCustomerMessageAt} />
        ) : null}
        {isMeta && !isComment ? (
          <MetaWindowIndicator
            lastCustomerMessageAt={conversation.lastCustomerMessageAt}
            thread={conversation.metaThread}
          />
        ) : null}
      </div>
    </header>
  );
}
