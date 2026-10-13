'use client';

import type { ReactNode } from 'react';
import { AgentAvatar, Avatar } from '@/components/avatar';
import { ChatBubble, ChatEvent, ChatReaction } from '@/components/chat';
import { BotIcon, ExternalIcon, PinIcon, UserIcon, WarningIcon } from '@/components/icons';
import { Tooltip } from '@/components/tooltip';
import { Badge } from '@/components/ui';
import { runPositions } from '@/lib/chat/runs';
import { formatDay, formatTime } from '@/lib/format';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { isPublicMetaMessage } from '@/lib/meta/visibility';
import {
  formatCoordinates,
  mapUrl,
  readSharedLocation,
  type SharedLocation,
} from '@/lib/tickets/shared-location';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import { deliveryOf, type MessageMeta, type Voice, voiceOf } from '@/lib/tickets/thread';
import { AttachmentList } from './attachments';
import { CommentModeration } from './comment-moderation';
import { SideConversationCard } from './side-conversations';

type Message = ConversationDetail['messages'][number];
type Side = ConversationDetail['sideConversations'][number];

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
  { kind: 'message'; at: Date; message: Message } | { kind: 'side'; at: Date; side: Side };

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

function Time({ at }: { at: Date }) {
  return <time dateTime={at.toISOString()}>{formatTime(at)}</time>;
}

export function Timeline({
  conversation,
  canSideConversation,
  canModerateComments,
  canViewContact,
}: {
  conversation: ConversationDetail;
  canSideConversation: boolean;
  canModerateComments: boolean;
  /** The avatar route answers 404 without `contact.view`, so no picture is asked for. */
  canViewContact: boolean;
}) {
  const readOnly = Boolean(readOnlyReason(conversation.channel));
  const items: ReactNode[] = [];
  let day: string | null = null;
  const byId = new Map(conversation.messages.map((message) => [message.id, message]));

  for (const entry of timelineEntries(conversation)) {
    // A reaction is drawn on the message it is about, so its own row draws
    // nothing — and is skipped before the day break, which would otherwise
    // announce a day with nothing in it when the reaction came the next morning.
    if (entry.kind === 'message' && entry.message.reaction?.targetId) continue;

    // A day break above the first entry of each Cairo day, before a side card
    // as well as a message — `formatDay` says why the zone is the team's.
    const label = formatDay(entry.at);
    if (label !== day) {
      items.push(
        <ChatEvent key={`day-${label}`} variant="day">
          {label}
        </ChatEvent>,
      );
      day = label;
    }

    if (entry.kind === 'side') {
      items.push(
        <SideConversationCard
          key={entry.side.id}
          side={entry.side}
          canWrite={canSideConversation && !readOnly}
        />,
      );
      continue;
    }

    const message = entry.message;

    // What the system says about the ticket — today, a form attachment that
    // could not be kept — is nobody's message. Drawn as an inbound bubble it
    // read as the customer's words, authored "Customer".
    if (message.kind === 'system') {
      items.push(
        <ChatEvent key={message.id}>
          <WarningIcon size={14} className="shrink-0 text-(--color-feedback-warning-fg)" />
          <span dir="auto">
            {message.bodyText} · <Time at={entry.at} />
          </span>
        </ChatEvent>,
      );
      continue;
    }

    if (message.reaction) {
      items.push(<UnplacedReaction key={message.id} message={message} at={entry.at} />);
      continue;
    }

    items.push(
      <MessageParts
        key={message.id}
        message={message}
        at={entry.at}
        canModerate={canModerateComments && !readOnly}
        canViewContact={canViewContact}
        reactions={
          message.reactions.length > 0 ? (
            <Reactions message={message} at={entry.at} byId={byId} />
          ) : undefined
        }
      />,
    );
  }

  return <ol className="flex flex-col">{items}</ol>;
}

/*
  The glyph each of our non-person voices is drawn with — on its tile beside a
  run, and on a reaction pill it sent — so the two cannot drift apart. A
  contact or an agent is drawn as their own avatar, and has no entry.
*/
const VOICE_GLYPH = { bot: BotIcon, 'business-app': UserIcon } as const;
const BotGlyph = VOICE_GLYPH.bot;
const BusinessAppGlyph = VOICE_GLYPH['business-app'];

/*
  The face beside a run: the writer's own, never the requester's. An inbound
  message on an email ticket can be a CC'd stranger, and the requester's photo
  on their words would be a claim about who wrote them — so the contact is the
  message's author, and one with no contact row behind it keeps the initials.

  A contact's picture is asked for only when this agent may fetch it: the
  avatar route answers 404 without `contact.view`, and the tile would fall
  back after a request per message that was never going to succeed.
*/
function AuthorTile({
  voice,
  message,
  canViewContact,
}: {
  voice: Voice;
  message: Message;
  canViewContact: boolean;
}) {
  switch (voice.avatar) {
    case 'contact':
      return (
        <Avatar
          name={voice.author}
          // Any id will do when no picture is asked for: it is never put in a URL.
          contactId={message.authorContactId ?? message.id}
          hasAvatar={
            canViewContact && message.authorContactId !== null && message.authorContactHasAvatar
          }
          size={28}
        />
      );
    case 'agent':
      return (
        <AgentAvatar
          name={voice.author}
          color={message.authorAgentColor}
          avatarUrl={message.authorAgentAvatarUrl}
          size={28}
        />
      );
    case 'bot':
      return (
        <span
          aria-hidden
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-(--color-border-strong) bg-(--color-background-hover) text-(--color-text-secondary)"
        >
          <BotGlyph size={16} />
        </span>
      );
    case 'business-app':
      // Neither an agent's colour nor the bot's dashed edge: somebody on the
      // team wrote it, but not through this console, so no agent is named.
      return (
        <span
          aria-hidden
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-(--color-border-default) bg-(--color-background-hover) text-(--color-text-secondary)"
        >
          <BusinessAppGlyph size={16} />
        </span>
      );
  }
}

type Part = 'text' | 'location' | 'files';

/**
 * One message, drawn as a short run of bubbles: its words, then a location it
 * shared, then its files — each its own block, so a photo is not squeezed
 * into the padding of a sentence. The author line opens the run and the time,
 * the receipt and everything about the message close it.
 *
 * Runs never join across messages, so every message keeps its own time and
 * receipt. Keyed per part, so a live update re-rendering the thread keeps an
 * opened picture open and a playing voice note playing.
 */
function MessageParts({
  message,
  at,
  canModerate,
  canViewContact,
  reactions,
}: {
  message: Message;
  at: Date;
  canModerate: boolean;
  canViewContact: boolean;
  /** On the last part: a reaction answers the message, not its caption or its photo. */
  reactions?: ReactNode;
}) {
  const meta = (message.meta ?? {}) as MessageMeta;
  const voice = voiceOf(message, meta);
  const isInbound = message.direction === 'inbound';

  const location = message.bodyHtml ? null : readSharedLocation(message.meta);
  const media = message.bodyHtml ? undefined : meta.media;

  const parts: Part[] = [];
  /*
    A pin replaces the text only when the text is the placeholder this same
    data generated — `[location (30.03, 31.23)]` — because showing both would
    print the coordinates twice and leave the useful one looking like a
    duplicate.

    Anything else the customer wrote is still shown above the card. No channel
    today sends words and a pin in one message, but a support tool silently
    dropping a customer's sentence is a much worse failure than a redundant
    line, so the card is additive wherever there is real text.
  */
  const hasText = message.bodyHtml
    ? true
    : message.bodyText.trim() !== '' && !(location && isLocationPlaceholder(message.bodyText));
  if (hasText) parts.push('text');
  if (location) parts.push('location');
  if (message.attachments.length > 0) parts.push('files');
  // Nothing at all to draw still gets its bubble, so the message is not lost.
  if (parts.length === 0) parts.push('text');

  const groups = runPositions(parts.map(() => message.id));
  const delivery = !isInbound && message.kind !== 'note' ? deliveryOf(message) : null;

  const extra = (
    <>
      {media && !media.downloaded ? (
        <p className="px-1 text-xs text-(--color-text-secondary)">
          {media.error ? `Attachment unavailable: ${media.error}` : 'Downloading attachment…'}
        </p>
      ) : null}
      {delivery?.note ? (
        <p
          className={`px-1 text-xs ${
            delivery.note.tone === 'warning'
              ? 'text-(--color-feedback-warning-fg)'
              : 'text-(--color-text-secondary)'
          }`}
        >
          {delivery.note.text}
        </p>
      ) : null}
      {isInbound && isPublicMetaMessage(meta) ? (
        <CommentModeration messageId={message.id} meta={message.meta} canModerate={canModerate} />
      ) : null}
    </>
  );

  return parts.map((part, index) => {
    const last = index === parts.length - 1;

    return (
      <ChatBubble
        key={`${message.id}:${part}`}
        from={voice.from}
        kind={part === 'text' ? voice.kind : 'attachment'}
        group={groups[index]}
        wide={part === 'text' && Boolean(message.bodyHtml)}
        author={voice.author}
        badge={
          voice.badges.length > 0
            ? voice.badges.map((badge) => (
                <Badge key={badge.label} tone={badge.tone}>
                  {badge.label}
                </Badge>
              ))
            : undefined
        }
        avatar={<AuthorTile voice={voice} message={message} canViewContact={canViewContact} />}
        time={<Time at={at} />}
        receipt={delivery?.receipt}
        reactions={last ? reactions : undefined}
        error={last ? delivery?.error : undefined}
        extra={last ? extra : undefined}
      >
        {part === 'text' ? (
          <MessageBody
            message={message}
            ownLinks={!(voice.from === 'out' && voice.kind === 'message')}
          />
        ) : part === 'location' && location ? (
          <SharedLocationCard location={location} />
        ) : (
          <AttachmentList files={message.attachments} />
        )}
      </ChatBubble>
    );
  });
}

/**
 * What a message carries now, as pills on its bubble.
 *
 * Whose side reacted is on the pill: the team's carries the wash and the
 * glyph its tile carries in the thread — the bot's, or the business app's —
 * and a customer's carries neither. Not the bubble's side, which says nothing
 * here: every reaction on the bot number that finds its message is a customer
 * reacting to their own. Who exactly, and when, is a tap away, because the
 * pill is the size of the emoji. The day is added only when it is not the
 * message's own, because "reacted · 09:12" under a message sent at 18:40 reads
 * as a clock running backwards.
 */
function Reactions({
  message,
  at,
  byId,
}: {
  message: Message;
  at: Date;
  byId: ReadonlyMap<string, Message>;
}) {
  return message.reactions.map(({ messageId, emoji }) => {
    const source = byId.get(messageId);
    if (!source) return null;

    const voice = voiceOf(source, (source.meta ?? {}) as MessageMeta);
    // Only our side's machine and phone have a glyph; an agent is a person with
    // an avatar of their own, and nothing in the console reacts on one's behalf.
    const Glyph =
      voice.from === 'out' && (voice.avatar === 'bot' || voice.avatar === 'business-app')
        ? VOICE_GLYPH[voice.avatar]
        : null;
    const reactedAt = new Date(source.createdAt);
    const sameDay = formatDay(reactedAt) === formatDay(at);

    return (
      <Tooltip
        key={messageId}
        label={`${voice.author} reacted with ${emoji}`}
        content={
          <>
            <bdi>{voice.author}</bdi> reacted
            {' · '}
            {sameDay ? null : `${formatDay(reactedAt)}, `}
            <Time at={reactedAt} />
          </>
        }
      >
        <ChatReaction
          emoji={emoji}
          mine={voice.from === 'out'}
          glyph={Glyph ? <Glyph size={12} className="shrink-0" /> : undefined}
        />
      </Tooltip>
    );
  });
}

/**
 * A reaction with nothing on this ticket to be drawn on: the customer bot's
 * own messages are never stored, and a customer can react to a message from an
 * earlier ticket. A line across the thread rather than a bubble, because
 * nobody said anything — and it says the message is elsewhere, where the bubble
 * it replaces read `[reacted 👍]` as if that were the customer's words.
 */
function UnplacedReaction({ message, at }: { message: Message; at: Date }) {
  const voice = voiceOf(message, (message.meta ?? {}) as MessageMeta);
  const emoji = message.reaction?.emoji;

  return (
    <ChatEvent>
      <span>
        <bdi>{voice.author}</bdi>{' '}
        {emoji ? (
          <>
            reacted <span className="font-emoji">{emoji}</span> to a message that isn’t on this
            ticket
          </>
        ) : emoji === '' ? (
          'took back a reaction to a message that isn’t on this ticket'
        ) : (
          // Tagged as a reaction, but its stored payload could not be read: say
          // that much rather than guess at the emoji or the message.
          'reacted to a message, but the reaction could not be read'
        )}
        {' · '}
        <Time at={at} />
      </span>
    </ChatEvent>
  );
}

function MessageBody({
  message,
  ownLinks,
}: {
  message: Message;
  /** False on our blue bubble, which makes links inherit its white. */
  ownLinks: boolean;
}) {
  if (message.bodyHtml) {
    // Sanitised at ingest and again on compose, never here: doing it at write
    // time means the stored row is safe for every consumer, not just this one.
    //
    // Normal white space, not the plain-text pre-wrap, or every newline in the
    // mail's source becomes a line break. A newsletter laid out at 600px
    // scrolls inside its bubble rather than pushing the thread sideways.
    return (
      <div
        className={`max-w-full overflow-x-auto whitespace-normal [&_img]:h-auto [&_img]:max-w-full [&_table]:max-w-full ${
          ownLinks ? '[&_a]:text-(--color-text-link) [&_a]:underline' : ''
        }`}
        dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
      />
    );
  }

  return <p className="whitespace-pre-wrap">{message.bodyText}</p>;
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
    <div className="w-60 max-w-full rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) px-3 py-2.5 text-start text-(--color-text-primary)">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <PinIcon size={16} className="shrink-0" />
        Shared location
      </p>

      {/* Customer-supplied text: React escapes it, and it is never put in the
          map URL — see the note on `mapUrl`. */}
      {label ? <p className="mt-1 text-sm whitespace-pre-wrap">{label}</p> : null}

      <p dir="ltr" className="mt-0.5 text-start font-mono text-xs text-(--color-text-secondary)">
        {formatCoordinates(location)}
      </p>

      <a
        href={mapUrl(location)}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-flex items-center gap-1 text-xs text-(--color-text-link) hover:underline"
      >
        Open in Google Maps
        <ExternalIcon size={13} className="shrink-0" />
      </a>
    </div>
  );
}
