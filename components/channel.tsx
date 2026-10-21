import type { ReactNode } from 'react';
import { GLOBE_SHAPES } from '@/components/icons';
import { CHANNEL_LABELS } from '@/lib/tickets/channel-labels';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';

/**
 * Channel identity in one place.
 *
 * An agent working a mixed inbox is switching between five sets of rules — a
 * 24-hour WhatsApp window, a 7-day Messenger one, a public Facebook comment —
 * and the channel is the single most useful thing to be able to see without
 * reading. So each gets its own mark and its own colour, and both come from
 * here rather than being re-invented per screen. A platform's comments share
 * its hue and are told apart by shape: the platform's glyph with the globe the
 * "Public comment" badge draws (`commentMark`), because several places draw
 * the mark without its label.
 *
 * The colours are the platforms' hues at tint strength — recognisable without
 * a legend, while a list of them still reads as one interface rather than as a
 * row of logos — and neutral for our own channels (email, portal, API), which
 * have no platform to borrow from. Web chat is cyan rather than the brand blue
 * it used to share with every button: each hue in the console means one thing,
 * and blue already means "act here". Instagram is magenta for the same reason.
 *
 * Each `className` is colour only, its border included, so one string dresses
 * both the badge here and the disc `channelMarkClass` draws on a conversation
 * row's avatar.
 */

export type Channel = string;

const FACEBOOK_GLYPH = (
  <path
    fill="currentColor"
    d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12z"
  />
);

const INSTAGRAM_GLYPH = (
  <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
    <circle cx="12" cy="12" r="3.6" />
    <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
  </g>
);

/**
 * A comment channel's mark: its platform's glyph drawn smaller toward the top
 * corner, and the globe over the bottom one, so the four Meta channels differ
 * in shape where only the mark is drawn — the inbox row, the ticket header on a
 * phone, a conversation row's avatar disc — and colour is never the only thing
 * telling a public thread from a private one.
 *
 * One svg, with a disc of the channel's own background behind the globe, rather
 * than a mask: these marks are static nodes repeated down a list, and each mask
 * would need an id of its own. The disc works because every place a mark is
 * drawn sits on its channel's background (`className` below).
 */
function commentMark(glyph: ReactNode, background: string): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3 shrink-0">
      <g transform="scale(0.78)">{glyph}</g>
      <circle cx="17" cy="17" r="7" style={{ fill: `var(${background})` }} />
      <g
        transform="translate(17 17) scale(0.62) translate(-12 -12)"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLOBE_SHAPES}
      </g>
    </svg>
  );
}

/**
 * Keyed by the enum, so a channel added to it does not compile until it has a
 * mark; the names come from `CHANNEL_LABELS`, which the text labels read too.
 */
const CHANNELS: Record<ConversationChannel, { label: string; className: string; mark: ReactNode }> =
  {
    email: {
      label: CHANNEL_LABELS.email,
      className: 'border-transparent bg-(--color-channel-email-bg) text-(--color-channel-email-fg)',
      mark: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 shrink-0"
        >
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      ),
    },
    whatsapp: {
      label: CHANNEL_LABELS.whatsapp,
      className:
        'border-transparent bg-(--color-channel-whatsapp-bg) text-(--color-channel-whatsapp-fg)',
      mark: (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="size-3 shrink-0">
          <path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.3A10 10 0 1 0 12 2zm5.5 14.1c-.2.6-1.2 1.2-1.7 1.2-.5.1-1 .1-1.6-.1a12 12 0 0 1-6.5-5.7c-.5-.9-.8-1.9-.1-2.8.2-.3.5-.5.8-.5h.6c.2 0 .4 0 .6.5l.8 1.9c.1.2 0 .4-.1.6l-.4.5c-.1.2-.3.3-.1.6a8.8 8.8 0 0 0 3.8 3.3c.3.1.5.1.7-.1l.7-.8c.2-.2.3-.2.6-.1l1.8.9c.3.1.4.2.4.4v.8z" />
        </svg>
      ),
    },
    whatsapp_bot: {
      // Not a variant of the WhatsApp badge. An agent scanning a list has to be
      // able to tell at a glance that a row is a transcript they cannot answer
      // from one that is waiting on them, and a green badge with different
      // wording is not that glance. Dashed and unfilled because the bot is
      // machine-written, which is what a dashed edge means everywhere in the
      // console — the bot's own bubbles in a thread are drawn the same way.
      label: CHANNEL_LABELS.whatsapp_bot,
      className:
        'border-dashed border-(--color-channel-bot-border) bg-(--color-channel-bot-bg) text-(--color-channel-bot-fg)',
      mark: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 shrink-0"
        >
          <rect x="4" y="8" width="16" height="11" rx="3" />
          <path d="M12 8V4.5" />
          <circle cx="9" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    webchat: {
      label: CHANNEL_LABELS.webchat,
      className:
        'border-transparent bg-(--color-channel-webchat-bg) text-(--color-channel-webchat-fg)',
      mark: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 shrink-0"
        >
          <path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4 20l1.3-3.5C4.5 15.4 4 14 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5z" />
        </svg>
      ),
    },
    facebook: {
      label: CHANNEL_LABELS.facebook,
      className:
        'border-transparent bg-(--color-channel-facebook-bg) text-(--color-channel-facebook-fg)',
      mark: (
        <svg viewBox="0 0 24 24" aria-hidden className="size-3 shrink-0">
          {FACEBOOK_GLYPH}
        </svg>
      ),
    },
    facebook_comment: {
      label: CHANNEL_LABELS.facebook_comment,
      className:
        'border-transparent bg-(--color-channel-facebook-comment-bg) text-(--color-channel-facebook-comment-fg)',
      mark: commentMark(FACEBOOK_GLYPH, '--color-channel-facebook-comment-bg'),
    },
    instagram: {
      label: CHANNEL_LABELS.instagram,
      className:
        'border-transparent bg-(--color-channel-instagram-bg) text-(--color-channel-instagram-fg)',
      mark: (
        <svg viewBox="0 0 24 24" aria-hidden className="size-3 shrink-0">
          {INSTAGRAM_GLYPH}
        </svg>
      ),
    },
    instagram_comment: {
      label: CHANNEL_LABELS.instagram_comment,
      className:
        'border-transparent bg-(--color-channel-instagram-comment-bg) text-(--color-channel-instagram-comment-fg)',
      mark: commentMark(INSTAGRAM_GLYPH, '--color-channel-instagram-comment-bg'),
    },
    portal: {
      label: CHANNEL_LABELS.portal,
      className:
        'border-transparent bg-(--color-channel-portal-bg) text-(--color-channel-portal-fg)',
      mark: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 shrink-0"
        >
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 9h17" />
        </svg>
      ),
    },
    api: {
      label: CHANNEL_LABELS.api,
      className: 'border-transparent bg-(--color-channel-api-bg) text-(--color-channel-api-fg)',
      mark: (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="size-3 shrink-0"
        >
          <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4" />
        </svg>
      ),
    },
  };

export function channelInfo(channel: Channel) {
  return (
    (Object.hasOwn(CHANNELS, channel) ? CHANNELS[channel as ConversationChannel] : null) ?? {
      label: channel,
      className:
        'border-transparent bg-(--color-feedback-neutral-bg) text-(--color-feedback-neutral-fg)',
      mark: null,
    }
  );
}

/**
 * The classes for a channel's mark on its own, as a small disc — the corner of a
 * conversation row's avatar, the channel list in the views panel. The caller
 * places it; `border` is here because the bot's dashed edge is a border style
 * and colour that would draw nothing without a width.
 */
export function channelMarkClass(channel: Channel): string {
  return `flex size-4.5 shrink-0 items-center justify-center rounded-full border ${channelInfo(channel).className}`;
}

/**
 * The channel's mark and hue, with or without its label.
 *
 * Without the label the mark still names itself, as text a screen reader reads
 * and nobody sees. Not a `title=` tooltip: it never appears on a phone, where
 * the console is read, and a tooltip is not something assistive technology can
 * be relied on to announce. A channel with no mark — one this file does not
 * know — keeps its label visible, or the row would show an empty coloured pill.
 *
 * 20px tall either way, the same as a Badge beside it: the 1px border is on
 * every channel, transparent on all but the bot, so the bot's dashed edge does
 * not make its chip taller than the rest of the row.
 */
export function ChannelBadge({
  channel,
  showLabel = true,
}: {
  channel: Channel;
  showLabel?: boolean;
}) {
  const info = channelInfo(channel);
  const labelled = showLabel || info.mark === null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border text-xs/4 font-medium whitespace-nowrap ${
        labelled ? 'px-1.5 py-px' : 'px-1 py-0.75'
      } ${info.className}`}
    >
      {info.mark}
      {labelled ? info.label : <span className="sr-only">{info.label}</span>}
    </span>
  );
}
