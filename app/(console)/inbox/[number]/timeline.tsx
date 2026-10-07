'use client';

import { Badge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { isPrivateReplyMessage, isPublicMetaMessage } from '@/lib/meta/visibility';
import {
  formatCoordinates,
  mapUrl,
  readSharedLocation,
  type SharedLocation,
} from '@/lib/tickets/shared-location';
import { lostReceiptNote } from '@/lib/whatsapp/receipts';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import { AttachmentList } from './attachments';
import { CommentModeration } from './comment-moderation';
import { SideConversationCard } from './side-conversations';

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

export function Timeline({
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
        const isPublicComment = isPublicMetaMessage(meta);
        const isPrivateReply = isPrivateReplyMessage(meta, message.direction);

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
              {isPrivateReply ? <Badge tone="neutral">sent privately</Badge> : null}
              {!isInbound && !isNote && meta.metaKind === 'direct_message' ? (
                <Badge tone="neutral">direct message</Badge>
              ) : null}
              <span className="ms-auto">{formatDateTime(message.createdAt)}</span>
            </div>

            <MessageBody message={message} />

            <AttachmentList files={message.attachments} />

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
      <p className="mt-1.5 whitespace-pre-wrap text-xs text-red-600">
        Not delivered — {message.deliveryError ?? 'unknown error'}
      </p>
    );
  }

  // Replaces the bare "sent" rather than sitting under it: that word alone is
  // what reads as confirmed, and here it never will be.
  const lostReceipt = lostReceiptNote(message);
  if (lostReceipt) {
    return <p className="mt-1.5 text-xs text-amber-700">{lostReceipt}</p>;
  }

  return (
    <p className="mt-1.5 text-xs text-[var(--muted-foreground)]/80">
      {message.deliveryStatus === 'pending' ? 'sending…' : message.deliveryStatus}
    </p>
  );
}
