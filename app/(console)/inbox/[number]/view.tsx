'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Avatar } from '@/components/avatar';
import { ChannelBadge } from '@/components/channel';
import { ChevronLeftIcon } from '@/components/icons';
import { Badge, Select } from '@/components/ui';
import { useNow } from '@/components/use-now';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import type { CannedResponseOption, ConversationDetail } from '@/lib/tickets/queries';
import { formatForInput, selectedValues, type TicketFieldDef } from '@/lib/tickets/custom-fields';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import {
  formatCoordinates,
  mapUrl,
  readSharedLocation,
  type SharedLocation,
} from '@/lib/tickets/shared-location';
import { describeRequesterRole } from '@/lib/shipments/roles';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import {
  linkShipment,
  linkShippingAccount,
  unlinkShipment,
  unlinkShippingAccount,
  updateTicket,
} from '../../actions';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import type { PickerEntry } from '@/lib/side-conversations/queries';
import { CommentModeration } from './comment-moderation';
import { ProfileRefresh } from './profile-refresh';
import { Composer, type KnowledgeContext } from './composer';
import { SideConversationCard, SideConversationsField } from './side-conversations';

/**
 * What sits where the composer would be, on a channel we only observe.
 *
 * A disabled textarea was the other option and is worse: it invites the agent to
 * try, and leaves them guessing why nothing happens. Saying plainly that the
 * conversation is not ours to answer is shorter and answers the question they
 * were about to ask.
 */
function ReadOnlyNotice({ reason, oneSided }: { reason: string; oneSided: boolean }) {
  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--muted)] px-4 py-3">
      <p className="flex items-start gap-2 text-xs text-[var(--muted-foreground)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0"
        >
          <rect x="4" y="10.5" width="16" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
        <span>{reason}</span>
      </p>

      {/*
        Said only when the other half is genuinely absent, and it disappears by
        itself the moment an echo lands. Without it a transcript with no replies
        in it reads as a customer talking to nobody — which is a different and
        much more alarming thing than a delivery setting being off.
      */}
      {oneSided ? (
        <p className="mt-2 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
          <span aria-hidden="true" className="mt-0.5">
            ⚠
          </span>
          <span>
            Only the customer&apos;s side of this conversation is here. The bot&apos;s replies reach
            us as Meta message echoes, and none have arrived — so the{' '}
            <span className="font-medium">message_echoes</span> field is not subscribed for this
            WhatsApp account.
          </span>
        </p>
      ) : null}
    </div>
  );
}

export type TemplateOption = {
  id: string;
  name: string;
  language: string;
  category: string;
  components: unknown[];
};

export function ConversationView({
  conversation,
  statuses,
  agents,
  groups,
  templates,
  recipients,
  fields,
  canned,
  knowledge,
  canSideConversation,
  canModerateComments,
  canEditContact,
  currentAgentId,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  templates: TemplateOption[];
  /** The admin-defined ticket fields, in the order they were arranged. */
  fields: TicketFieldDef[];
  /** The internal directory, for the composer's side conversation tab. */
  recipients: PickerEntry[];
  /** Reusable replies, already scoped to this agent's own and their groups'. */
  canned: CannedResponseOption[];
  /** Null when the agent lacks `kb.view`, or on a channel with no composer. */
  knowledge: KnowledgeContext | null;
  canSideConversation: boolean;
  /** Whether this agent may hide or delete a public comment. */
  canModerateComments: boolean;
  /** Whether this agent may re-read the customer's profile from Meta. */
  canEditContact: boolean;
  currentAgentId: string;
}) {
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <Header conversation={conversation} canEditContact={canEditContact} />

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <Timeline
            conversation={conversation}
            canSideConversation={canSideConversation}
            canModerateComments={canModerateComments}
          />
        </div>

        {readOnlyReason(conversation.channel) ? (
          <ReadOnlyNotice
            reason={readOnlyReason(conversation.channel)!}
            oneSided={!conversation.messages.some((m) => m.direction === 'outbound')}
          />
        ) : (
          <Composer
            conversation={conversation}
            templates={templates}
            recipients={recipients}
            canned={canned}
            knowledge={knowledge}
            canSideConversation={canSideConversation}
          />
        )}
      </div>

      <Sidebar
        conversation={conversation}
        statuses={statuses}
        agents={agents}
        groups={groups}
        fields={fields}
        currentAgentId={currentAgentId}
      />
    </div>
  );
}

function Header({
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

/** The Messenger and Instagram windows, in the agent's terms. */
function MetaWindowIndicator({
  lastCustomerMessageAt,
  thread,
}: {
  lastCustomerMessageAt: Date | string | null;
  thread: ConversationDetail['metaThread'];
}) {
  const now = useNow();

  // A thread that cannot be answered at all has no window worth counting, and
  // the countdown would contradict the composer standing beside it. Rendered
  // before the mount guard because this one is server-computed and does not
  // tick — there is no first frame to get wrong.
  if (thread && !thread.canSend) {
    return (
      <Badge tone="closed">
        {thread.reason === 'standby' ? 'Another app owns this inbox' : 'Cannot reply from here'}
      </Badge>
    );
  }

  if (!now) return null;

  const state = metaWindowState(
    lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null,
    now,
  );

  return (
    <Badge tone={state.isOpen ? 'open' : state.needsHumanAgentTag ? 'warning' : 'closed'}>
      {describeWindow(state)}
    </Badge>
  );
}

/**
 * Live countdown, ticking client-side.
 *
 * A window that silently expires while an agent is composing is the single
 * worst WhatsApp failure mode, so the number has to move rather than reflect
 * whenever the page last rendered.
 */
function WindowIndicator({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const last = lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null;
  const now = useNow();

  // Null until mounted. Rendering nothing for that first pass is deliberate:
  // a countdown computed on the server would be wrong by the time it arrived.
  if (!now) return null;

  const state = windowState(last, now);

  return state.isOpen ? (
    <Badge tone={state.remainingMs < 2 * 60 * 60 * 1000 ? 'warning' : 'open'}>
      window {formatRemaining(state.remainingMs)}
    </Badge>
  ) : (
    <Badge tone="closed">window closed — template only</Badge>
  );
}

/**
 * Messages and side conversations, in one ordered list.
 *
 * Interleaved rather than kept in a separate panel because the chronology is the
 * information: "the customer complained at 09:12, we asked the hub at 09:20, the
 * hub answered at 11:40, we replied at 11:44" is the story of the ticket, and a
 * thread parked in a side panel takes the middle two out of it. This is the
 * shape Freshworks arrived at with anchored threads, and it is right.
 *
 * A side conversation sorts by when it was *started*, not by its latest message.
 * Sorting by activity would move a card that has been sitting on the ticket for
 * two days down past a reply the agent wrote afterwards, and the agent's memory
 * of the ticket is "I asked the hub after she wrote in".
 */
type TimelineEntry =
  | { kind: 'message'; at: Date; message: ConversationDetail['messages'][number] }
  | { kind: 'side'; at: Date; side: ConversationDetail['sideConversations'][number] };

function timelineEntries(conversation: ConversationDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...conversation.messages.map((message): TimelineEntry => ({
      kind: 'message',
      at: new Date(message.createdAt),
      message,
    })),
    ...conversation.sideConversations.map((side): TimelineEntry => ({
      kind: 'side',
      at: new Date(side.createdAt),
      side,
    })),
  ];

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function Timeline({
  conversation,
  canSideConversation,
  canModerateComments,
}: {
  conversation: ConversationDetail;
  canSideConversation: boolean;
  canModerateComments: boolean;
}) {
  return (
    <ol className="flex flex-col gap-4">
      {timelineEntries(conversation).map((entry) => {
        if (entry.kind === 'side') {
          return (
            <SideConversationCard
              key={entry.side.id}
              side={entry.side}
              canWrite={canSideConversation && !readOnlyReason(conversation.channel)}
            />
          );
        }

        const message = entry.message;
        const isNote = message.kind === 'note';
        const isInbound = message.direction === 'inbound';
        const meta = (message.meta ?? {}) as {
          metaKind?: string;
          isPublic?: boolean;
          echo?: boolean;
        };
        const isPublicComment = meta.metaKind === 'comment';

        return (
          <li
            key={message.id}
            className={`max-w-[46rem] rounded-lg border px-3.5 py-2.5 ${
              isNote
                ? 'border-amber-500/30 bg-amber-500/10'
                : isInbound
                  ? 'border-[var(--border)] bg-[var(--surface)]'
                  : 'ms-auto border-brand-500/30 bg-brand-500/8'
            }`}
          >
            <div className="mb-1.5 flex items-baseline gap-2 text-xs text-[var(--muted-foreground)]">
              <span className="font-medium">
                {/*
                  An echo has no author on either side: no agent wrote it and the
                  customer did not send it. "Automation" would be technically
                  true and useless — it was the customer bot, and on a channel
                  that mirrors two parties, saying which one matters most.
                */}
                {message.authorName ??
                  (meta.echo ? 'Customer bot' : isInbound ? 'Customer' : 'Automation')}
              </span>
              {isNote ? <Badge tone="warning">private note</Badge> : null}
              {/* Whether a reply was public is the thing an agent most needs to
                  be sure of on a social ticket, so it is stated rather than
                  implied by which column the bubble is in. */}
              {isPublicComment ? (
                <Badge tone={isInbound ? 'neutral' : 'warning'}>
                  {isInbound ? 'public comment' : 'posted publicly'}
                </Badge>
              ) : null}
              {!isInbound && !isNote && meta.metaKind === 'direct_message' ? (
                <Badge tone="neutral">direct message</Badge>
              ) : null}
              <span className="ms-auto">{formatDateTime(message.createdAt)}</span>
            </div>

            <MessageBody message={message} />

            {message.attachments.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {message.attachments.map((file) => (
                  <li
                    key={file.id}
                    className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                  >
                    <a
                      href={`/api/attachments/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {file.filename}
                    </a>
                    <span className="ms-1.5 text-[var(--muted-foreground)]">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {isInbound && isPublicComment ? (
              <CommentModeration
                messageId={message.id}
                meta={message.meta}
                canModerate={canModerateComments && !readOnlyReason(conversation.channel)}
              />
            ) : null}

            {!isInbound && !isNote ? <DeliveryState message={message} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function MessageBody({ message }: { message: ConversationDetail['messages'][number] }) {
  if (message.bodyHtml) {
    // Sanitised at ingest and again on compose, never here: doing it at write
    // time means the stored row is safe for every consumer, not just this one.
    return (
      <div
        className="prose-sm max-w-none text-sm [&_a]:text-brand-600 [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
      />
    );
  }

  const media = (message.meta as { media?: { downloaded?: boolean; error?: string } }).media;
  const location = readSharedLocation(message.meta);

  return (
    <>
      {/*
        A pin replaces the text only when the text is the placeholder this same
        data generated — `[location (30.03, 31.23)]` — because showing both
        would print the coordinates twice and leave the useful one looking like
        a duplicate.

        Anything else the customer wrote is still shown above the card. No
        channel today sends words and a pin in one message, but a support tool
        silently dropping a customer's sentence is a much worse failure than a
        redundant line, so the card is additive wherever there is real text.
      */}
      {location && isLocationPlaceholder(message.bodyText) ? null : (
        <p className="whitespace-pre-wrap text-sm">{message.bodyText}</p>
      )}
      {location ? <SharedLocationCard location={location} /> : null}
      {media && !media.downloaded ? (
        <p className="mt-1 text-xs opacity-50">
          {media.error ? `Attachment unavailable: ${media.error}` : 'Downloading attachment…'}
        </p>
      ) : null}
    </>
  );
}

/**
 * Whether this body is only the generated stand-in for a pin.
 *
 * Matched on the prefix rather than rebuilt from the coordinates: `displayText`
 * writes the place name into the same string, so an exact comparison would fail
 * on every pin that carries one and print the coordinates twice.
 */
function isLocationPlaceholder(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  return trimmed === '' || (trimmed.startsWith('[location') && trimmed.endsWith(']'));
}

/**
 * A location a customer shared.
 *
 * No embedded map. A static map image needs a Google API key this system does
 * not hold and would put a third-party request on every ticket render, which is
 * a CSP change and a per-view cost for something an agent only sometimes wants.
 * The link hands off to the Maps app on a phone, which is where somebody
 * chasing an address is usually standing.
 *
 * The coordinates stay on screen as text as well as in the link: an agent
 * relaying a drop point to a driver over the phone reads them out.
 */
function SharedLocationCard({ location }: { location: SharedLocation }) {
  const label = [location.name, location.address].filter(Boolean).join(' · ');

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span aria-hidden="true">📍</span>
        <span className="text-sm font-medium">Shared location</span>
      </div>

      {/* Customer-supplied text: React escapes it, and it is never put in the
          map URL — see the note on `mapUrl`. */}
      {label ? <p className="mt-1 whitespace-pre-wrap text-sm">{label}</p> : null}

      <p className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
        {formatCoordinates(location)}
      </p>

      <a
        href={mapUrl(location)}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block text-xs text-brand-600 underline"
      >
        Open in Google Maps
      </a>
    </div>
  );
}

function DeliveryState({ message }: { message: ConversationDetail['messages'][number] }) {
  if (message.deliveryStatus === 'failed') {
    return (
      // A delivery error explains itself in paragraphs — what Meta said, and
      // what it means — so it is wrapped rather than run together into one line.
      <p className="mt-1.5 whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
        Not delivered — {message.deliveryError ?? 'unknown error'}
      </p>
    );
  }

  return (
    <p className="mt-1.5 text-xs text-[var(--muted-foreground)]/80">
      {message.deliveryStatus === 'pending' ? 'sending…' : message.deliveryStatus}
    </p>
  );
}

function Sidebar({
  conversation,
  statuses,
  agents,
  groups,
  fields,
  currentAgentId,
}: {
  conversation: ConversationDetail;
  statuses: { id: string; name: string; category: string }[];
  agents: { id: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
  fields: TicketFieldDef[];
  currentAgentId: string;
}) {
  return (
    <aside className="app-scroll hidden w-64 shrink-0 overflow-y-auto border-s border-[var(--border)] bg-[var(--surface)] p-3 xl:block">
      <Field label="Status">
        <FieldSelect
          conversationId={conversation.id}
          field="status"
          value={conversation.statusId}
          options={statuses.map((s) => ({ value: s.id, label: s.name }))}
        />
      </Field>

      <Field label="Assignee">
        <FieldSelect
          conversationId={conversation.id}
          field="assignee"
          value={conversation.assigneeAgentId ?? ''}
          options={[
            { value: '', label: 'Unassigned' },
            ...agents.map((a) => ({
              value: a.id,
              label: a.id === currentAgentId ? `${a.name} (me)` : a.name,
            })),
          ]}
        />
      </Field>

      <Field label="Group">
        <FieldSelect
          conversationId={conversation.id}
          field="group"
          value={conversation.groupId ?? ''}
          options={[
            { value: '', label: 'None' },
            ...groups.map((g) => ({ value: g.id, label: g.name })),
          ]}
        />
      </Field>

      <Field label="Priority">
        <FieldSelect
          conversationId={conversation.id}
          field="priority"
          value={conversation.priority}
          options={['low', 'medium', 'high', 'urgent'].map((p) => ({ value: p, label: p }))}
        />
      </Field>

      <Field label="Tags">
        <TagField conversationId={conversation.id} tags={conversation.tags} />
      </Field>

      <CustomFields conversation={conversation} fields={fields} />

      <ShipmentsField conversation={conversation} />
      <ShippingAccountsField conversation={conversation} />

      <Field label="Side conversations">
        <SideConversationsField sides={conversation.sideConversations} />
      </Field>

      <div className="mt-5 border-t border-[var(--border)] pt-3">
        <h2 className="mb-2 text-xs font-medium opacity-70">Activity</h2>
        <ol className="flex flex-col gap-1.5 text-xs opacity-60">
          {conversation.events.slice(0, 12).map((event) => (
            <li key={event.id}>
              <span className="font-medium">{event.actorName ?? 'System'}</span>{' '}
              {describeEvent(event.type, event.data)}
              <span className="ml-1 opacity-60">{formatRelative(event.createdAt)}</span>
            </li>
          ))}
          {conversation.events.length === 0 ? (
            <li className="opacity-50">No changes yet.</li>
          ) : null}
        </ol>
      </div>
    </aside>
  );
}

const SKIP_REASONS: Record<string, string> = {
  outside_hours: 'the group was outside its business hours',
  no_group_members: 'the group has no members',
  none_available: 'nobody in the group was online and accepting tickets',
  all_at_capacity: 'everybody available was at their ticket limit',
  no_skill_match: 'nobody available held every skill it needs',
};

function describeEvent(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'status_changed':
      return `set status to ${String(data.to ?? '')}`;
    case 'priority_changed':
      return `set priority to ${String(data.to ?? '')}`;
    case 'assigned':
      return 'reassigned the ticket';
    case 'unassigned':
      return 'unassigned the ticket';
    case 'group_changed':
      return 'moved the ticket to another group';
    /*
     * The whole point of recording a refusal. A queue that assigns itself has to
     * be able to say why it did not, in a sentence an agent looking at the ticket
     * can act on — "everybody is at their limit" is a different problem from
     * "nobody has the skill", and both are different from "we were shut".
     */
    case 'assignment_skipped':
      return `could not assign it: ${SKIP_REASONS[String(data.reason)] ?? String(data.reason)}`;
    case 'assignment_reclaimed':
      return 'took the ticket back — the agent it was with went offline before replying';
    case 'assignment_escalated':
      return 'escalated it: nobody had picked it up';
    case 'reopened':
      return 'reopened the ticket';
    case 'sla_paused':
      return 'paused the SLA clock';
    case 'sla_resumed':
      return `resumed the SLA clock after ${String(data.pausedMinutes ?? 0)} minutes`;
    case 'shipments_detected': {
      const tracking = Array.isArray(data.trackingNumbers) ? data.trackingNumbers : [];
      const sbids = Array.isArray(data.sbids) ? data.sbids : [];
      const parts = [
        tracking.length ? `shipment${tracking.length > 1 ? 's' : ''} ${tracking.join(', ')}` : null,
        sbids.length ? `account${sbids.length > 1 ? 's' : ''} ${sbids.join(', ')}` : null,
      ].filter(Boolean);
      return `linked ${parts.join(' and ')} from a message`;
    }
    case 'shipment_linked':
      return `linked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipment_unlinked':
      return `unlinked shipment ${String(data.trackingNumber ?? '')}`;
    case 'shipping_account_linked':
      return `linked account ${String(data.sbid ?? '')}`;
    case 'shipping_account_unlinked':
      return `unlinked account ${String(data.sbid ?? '')}`;
    case 'side_conversation_started':
      return `started a side conversation with ${String(data.to ?? 'an internal team')}`;
    case 'side_conversation_replied':
      // The actor here is the person at the hub, so the name is already printed
      // ahead of this sentence by the caller.
      return `replied on side conversation #${String(data.sideConversationNumber ?? '')}`;
    case 'custom_field_changed': {
      // The value, not just the field name. "set Root cause to damaged in
      // transit" is the whole record; "changed Root cause" sends whoever is
      // reading back through the ticket to work out what it was changed to.
      const label = String(data.label ?? data.key ?? 'a field');
      const to = data.to;
      if (to === null || to === undefined || to === '') return `cleared ${label}`;
      return `set ${label} to ${Array.isArray(to) ? to.join(', ') : String(to)}`;
    }
    case 'profile_refreshed': {
      const name = data.name;
      return name
        ? `looked the customer up at Meta: ${String(name)}`
        : 'looked the customer up at Meta, which had no name for them';
    }
    case 'profile_refresh_refused':
      return data.permission === true
        ? 'asked Meta for the customer\u2019s profile and was refused — the app may not hold Business Asset User Profile Access'
        : 'asked Meta for the customer\u2019s profile and was refused';
    case 'comment_hidden':
      return 'hid the comment on the post';
    case 'comment_unhidden':
      return 'made the comment public again';
    case 'comment_deleted':
      return 'deleted the comment from the post';
    case 'sla_recalculated':
      return data.reason === 'group_hours'
        ? "re-counted the due dates on the new group's business hours"
        : 're-counted the due dates';
    default:
      return type.replace(/_/g, ' ');
  }
}

function Field({
  label,
  hint,
  as = 'block',
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /**
   * `group` for a set of controls one label cannot belong to — the checkboxes
   * of a multi-select. Assistive technology reads the label once for the set
   * rather than leaving each box unnamed.
   */
  as?: 'block' | 'group';
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3" {...(as === 'group' ? { role: 'group', 'aria-label': label } : {})}>
      <p className="mb-1 text-xs font-medium opacity-60">{label}</p>
      {children}
      {hint ? <p className="mt-1 text-xs opacity-60">{hint}</p> : null}
    </div>
  );
}

/**
 * Saves on change with no explicit save button, matching Freshdesk. The router
 * refresh re-reads the server components so the timeline picks up the audit
 * entry the action just wrote.
 */
function FieldSelect({
  conversationId,
  field,
  value,
  options,
}: {
  conversationId: string;
  field: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string) {
    setSaving(true);
    setError(null);

    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('field', field);
    formData.set('value', next);

    const result = await updateTicket({ error: null }, formData);
    setSaving(false);

    if (result.error) setError(result.error);
    else router.refresh();
  }

  return (
    <>
      <Select value={value} disabled={saving} onChange={(e) => save(e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </>
  );
}

function TagField({ conversationId, tags }: { conversationId: string; tags: string[] }) {
  const router = useRouter();
  const [value, setValue] = useState(tags.join(', '));
  const [saving, setSaving] = useState(false);

  async function save() {
    if (value === tags.join(', ')) return;
    setSaving(true);

    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('field', 'tags');
    formData.set('value', value);

    await updateTicket({ error: null }, formData);
    setSaving(false);
    router.refresh();
  }

  return (
    <input
      value={value}
      disabled={saving}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      placeholder="comma, separated"
      className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-brand-500"
    />
  );
}

/**
 * The admin-defined ticket fields.
 *
 * These are the first controls in the console ever to write
 * `conversations.custom_fields`. Until this existed an admin could define a
 * field, an automation could be written against `custom.<key>`, and the column
 * stayed `{}` on every ticket — so the rule matched nothing and nothing said so.
 *
 * One control per field rather than a single JSON box: the type is what decides
 * whether a stored 12 is a number a rule can order or a string it cannot, and a
 * free-text box would put that decision on whoever is typing.
 */
function CustomFields({
  conversation,
  fields,
}: {
  conversation: ConversationDetail;
  fields: TicketFieldDef[];
}) {
  if (fields.length === 0) return null;

  return (
    <>
      {fields.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          as={field.type === 'multi_select' ? 'group' : 'block'}
          hint={
            field.requiredOnResolve ? (
              <span className="opacity-70">Needed before this ticket can be resolved.</span>
            ) : null
          }
        >
          <CustomFieldControl
            conversationId={conversation.id}
            field={field}
            value={conversation.customFields[field.key]}
          />
        </Field>
      ))}
    </>
  );
}

function CustomFieldControl({
  conversationId,
  field,
  value,
}: {
  conversationId: string;
  field: TicketFieldDef;
  value: unknown;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => formatForInput(field, value));

  async function save(next: string | string[]) {
    setSaving(true);
    setError(null);

    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('field', `custom:${field.key}`);
    // `append`, so a multi-select arrives as the several values it is rather
    // than one comma-joined string the action would have to guess how to split.
    if (Array.isArray(next)) for (const entry of next) formData.append('value', entry);
    else formData.set('value', next);

    const result = await updateTicket({ error: null }, formData);
    setSaving(false);

    if (result.error) setError(result.error);
    else router.refresh();
  }

  const control = () => {
    switch (field.type) {
      case 'checkbox':
        return (
          <input
            type="checkbox"
            checked={value === true}
            disabled={saving}
            onChange={(e) => save(e.target.checked ? 'on' : '')}
            className="size-4 accent-brand-500"
          />
        );

      case 'dropdown':
        return (
          <Select
            value={String(value ?? '')}
            disabled={saving}
            onChange={(e) => save(e.target.value)}
          >
            <option value="">—</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        );

      case 'multi_select': {
        const chosen = selectedValues(value);
        return (
          <div className="flex flex-col gap-1">
            {field.options.map((option) => (
              <label key={option.value} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={chosen.includes(option.value)}
                  disabled={saving}
                  onChange={(e) =>
                    save(
                      e.target.checked
                        ? [...chosen, option.value]
                        : chosen.filter((entry) => entry !== option.value),
                    )
                  }
                  className="size-3.5 accent-brand-500"
                />
                {option.label}
              </label>
            ))}
            {field.options.length === 0 ? (
              <span className="text-xs opacity-50">No options defined.</span>
            ) : null}
          </div>
        );
      }

      case 'paragraph':
        return (
          <textarea
            rows={3}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== formatForInput(field, value) && save(draft)}
            className={INPUT_CLASS}
          />
        );

      // Date and time controls commit on change: they have no meaningful
      // intermediate state to protect, and a picker that saved on blur would
      // lose the choice if the agent clicked straight onto another field.
      case 'date':
      case 'datetime':
        return (
          <input
            type={field.type === 'date' ? 'date' : 'datetime-local'}
            value={draft}
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value);
              void save(e.target.value);
            }}
            className={INPUT_CLASS}
          />
        );

      default:
        return (
          <input
            type={field.type === 'number' || field.type === 'decimal' ? 'number' : 'text'}
            step={field.type === 'decimal' ? 'any' : field.type === 'number' ? '1' : undefined}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => draft !== formatForInput(field, value) && save(draft)}
            className={INPUT_CLASS}
          />
        );
    }
  };

  return (
    <>
      {control()}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </>
  );
}

const INPUT_CLASS =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-brand-500';

/**
 * The parcels a ticket is about.
 *
 * An unsynced shipment says so rather than showing a row of blanks: it was
 * created from a number somebody wrote down and nothing has confirmed it exists,
 * which is a different thing from a shipment with no shipper.
 *
 * The add control is a plain input saved on Enter, matching `TagField` above.
 * This codebase has no modals, and a dialog that scrolls inside a scrolling page
 * would be the first one.
 */
function ShipmentsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <Field label="Shipments">
      <ul className="mb-2 flex flex-col gap-2">
        {conversation.shipments.map((shipment) => (
          <li key={shipment.shipmentId} className="text-xs">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/contacts/shipments/${encodeURIComponent(shipment.trackingNumber)}`}
                className="font-medium break-all hover:underline"
              >
                {shipment.trackingNumber}
              </Link>
              <UnlinkButton
                action={unlinkShipment}
                fields={{
                  conversationId: conversation.id,
                  shipmentId: shipment.shipmentId,
                  trackingNumber: shipment.trackingNumber,
                }}
                label={`Unlink ${shipment.trackingNumber}`}
              />
            </div>

            <p className="mt-0.5 opacity-60">
              {shipment.syncState === 'synced'
                ? (shipment.statusLabel ?? 'No status yet')
                : shipment.syncState === 'not_found'
                  ? 'Not a shipment on the platform'
                  : 'Not synced yet'}
            </p>
            <p className="opacity-60">{describeRequesterRole(shipment.requesterRole)}</p>

            <div className="mt-1 flex flex-wrap items-center gap-1">
              {shipment.sbid ? (
                <Link href={`/contacts/accounts/${encodeURIComponent(shipment.sbid)}`}>
                  <Badge>SBID {shipment.sbid}</Badge>
                </Link>
              ) : null}
              {shipment.linkSource === 'detected' ? <Badge>auto</Badge> : null}
            </div>
          </li>
        ))}
        {conversation.shipments.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShipment}
        conversationId={conversation.id}
        name="trackingNumber"
        placeholder="Add a tracking number"
      />
    </Field>
  );
}

/**
 * SBIDs this ticket names.
 *
 * A mention, not a membership. Somebody quoting an account number in a message
 * says the number came up here; saying they belong to that account is a claim
 * about their identity and is made on the customer's own page instead.
 */
function ShippingAccountsField({ conversation }: { conversation: ConversationDetail }) {
  return (
    <Field label="Shipping accounts">
      <ul className="mb-2 flex flex-col gap-1.5">
        {conversation.shippingAccounts.map((account) => (
          <li key={account.shippingAccountId} className="flex items-center justify-between gap-2">
            <Link
              href={`/contacts/accounts/${encodeURIComponent(account.sbid)}`}
              className="text-xs font-medium hover:underline"
            >
              {account.name ?? `SBID ${account.sbid}`}
            </Link>
            <div className="flex items-center gap-1">
              {account.linkSource === 'detected' ? <Badge>auto</Badge> : null}
              <UnlinkButton
                action={unlinkShippingAccount}
                fields={{
                  conversationId: conversation.id,
                  shippingAccountId: account.shippingAccountId,
                  sbid: account.sbid,
                }}
                label={`Unlink ${account.sbid}`}
              />
            </div>
          </li>
        ))}
        {conversation.shippingAccounts.length === 0 ? (
          <li className="text-xs opacity-50">None linked.</li>
        ) : null}
      </ul>

      <LinkInput
        action={linkShippingAccount}
        conversationId={conversation.id}
        name="sbid"
        placeholder="Add an SBID"
      />
    </Field>
  );
}

type LinkAction = (
  state: { error: string | null },
  formData: FormData,
) => Promise<{ error: string | null }>;

function LinkInput({
  action,
  conversationId,
  name,
  placeholder,
}: {
  action: LinkAction;
  conversationId: string;
  name: string;
  placeholder: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) return;

    setSaving(true);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set(name, trimmed);

    const result = await action({ error: null }, formData);
    setSaving(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    setError(null);
    setValue('');
    router.refresh();
  }

  return (
    <div>
      <input
        value={value}
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
        onBlur={() => void save()}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs outline-none focus:border-brand-500"
      />
      {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

/**
 * Two-click removal, inline rather than importing `DangerAction` from the admin
 * forms. Reaching into admin internals from the inbox would couple two areas
 * that have stayed apart; promoting that component into `components/ui.tsx` is
 * the better move and a wider change than this feature should carry.
 */
function UnlinkButton({
  action,
  fields,
  label,
}: {
  action: LinkAction;
  fields: Record<string, string>;
  label: string;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    await action({ error: null }, formData);
    setBusy(false);
    setArmed(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => (armed ? void remove() : setArmed(true))}
      onBlur={() => setArmed(false)}
      className="shrink-0 rounded px-1 text-xs opacity-50 hover:opacity-100"
    >
      {armed ? 'Sure?' : '\u00d7'}
    </button>
  );
}
