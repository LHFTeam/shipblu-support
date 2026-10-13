import type { ReactNode } from 'react';
import type { RunPosition } from '@/lib/chat/runs';
import { AlertCircleIcon, BotIcon, CheckDoubleIcon, CheckIcon, ClockIcon, LockIcon } from './icons';

/**
 * One message in a chat thread, on whichever surface draws one: the console's
 * ticket, the widget and the help centre's portal.
 *
 * `from` is relative to the viewer, not to the business. An agent's own replies
 * are `out` in the console, and a customer's are `out` in the widget and the
 * portal, because what a reader needs from the layout is "which of these did I
 * send", and a thread that put the business on the end side everywhere would
 * show a customer their own words in the colour of somebody else's.
 *
 * No `'use client'`, and nothing here may need one: the portal and the console
 * render threads on the server, and a hook here would turn every message of a
 * long ticket into client JavaScript.
 *
 * Render inside `<ol className="flex flex-col">` with no gap. Spacing comes
 * from the bubbles themselves, because it depends on who is next to whom: 14px
 * where the sender changes, 2px inside a run (`lib/chat/runs.ts`).
 */
export type ChatBubbleProps = {
  from?: 'in' | 'out';
  /**
   * A note is amber with a lock because it is never sent; a bot message is
   * dashed because nobody wrote it. `attachment` draws no bubble at all, for a
   * part that is already a card of its own (a location, a list of files).
   */
  kind?: 'message' | 'note' | 'bot' | 'attachment';
  /** Every corner round by default; `tail` squares the corner nearest the sender. */
  shape?: 'round' | 'tail';
  group?: RunPosition;
  /**
   * A wider cap, for a body that is a laid-out document rather than a line of
   * chat — an email's HTML — which squeezed into 36rem wraps every table it has.
   */
  wide?: boolean;
  /** Shown on the first bubble of a run. */
  author?: ReactNode;
  /** After the author, e.g. `<Badge tone="note">Private note</Badge>`. */
  badge?: ReactNode;
  /**
   * Passing anything — `null` included — reserves the avatar column on every
   * bubble of the run, so the bubbles line up; the avatar itself is drawn on
   * the last one. Leave it undefined on a surface that has no avatars.
   */
  avatar?: ReactNode;
  /** Under the last bubble of a run. Pass a `<time dateTime>` so it is machine-readable. */
  time?: ReactNode;
  receipt?: 'sending' | 'sent' | 'delivered' | 'read';
  /** The receipt's word in the reader's language, where it is not English. */
  receiptLabel?: ReactNode;
  /**
   * `ChatReaction`s, pinned to the bubble's bottom edge on the side away from
   * the sender. On the bubble rather than under it, because a reaction is an
   * answer to this message and nothing else: a line below reads as one more
   * thing said, and lands beside whatever is drawn next.
   */
  reactions?: ReactNode;
  /** A delivery failure, in danger text under the bubble. Line breaks are kept. */
  error?: ReactNode;
  /**
   * Whatever else belongs to this message but not inside it — moderation
   * controls, a media download's progress, a note about a lost receipt. Under
   * the bubble, on the thread's own background, because faded text on the blue
   * is unreadable and a button inside the bubble reads as part of the message.
   */
  extra?: ReactNode;
  lang?: string;
  /**
   * The body. Not `white-space: pre-wrap` here, unlike the design system's
   * bubble: a sanitised email's HTML would gain a line break for every newline
   * in its source. A caller drawing plain text adds it.
   */
  children?: ReactNode;
};

const RECEIPTS = {
  sending: { icon: ClockIcon, label: 'Sending…' },
  sent: { icon: CheckIcon, label: 'Sent' },
  delivered: { icon: CheckDoubleIcon, label: 'Delivered' },
  read: { icon: CheckDoubleIcon, label: 'Read' },
} as const;

/*
  Written out per kind and side rather than layered, because two utilities for
  the same property are ordered by Tailwind, not by where they sit in the class
  list — a note's amber added after the grey would lose to it half the time.
*/
const BUBBLE_TONE = {
  in: 'border-(--color-bubble-in-border) bg-(--color-bubble-in-bg) text-(--color-bubble-in-fg)',
  // Links inherit the white on blue: the link blue on brand blue is invisible.
  out: 'border-(--color-bubble-out-border) bg-(--color-bubble-out-bg) text-(--color-bubble-out-fg) [&_a]:text-inherit [&_a]:underline',
  note: 'border-(--color-bubble-note-border) bg-(--color-bubble-note-bg) text-(--color-text-primary)',
  bot: 'border-dashed border-(--color-bubble-bot-border) bg-(--color-bubble-bot-bg) text-(--color-text-primary)',
} as const;

/*
  The corner nearest the sender, squared on every bubble of a run, and the one
  facing the previous bubble too once the run has started — so a run reads as
  one block hanging off its sender's side.
*/
const TAIL = {
  in: {
    single: 'rounded-es-bubble-tail',
    first: 'rounded-es-bubble-tail',
    middle: 'rounded-ss-bubble-tail rounded-es-bubble-tail',
    last: 'rounded-ss-bubble-tail rounded-es-bubble-tail',
  },
  out: {
    single: 'rounded-ee-bubble-tail',
    first: 'rounded-ee-bubble-tail',
    middle: 'rounded-se-bubble-tail rounded-ee-bubble-tail',
    last: 'rounded-se-bubble-tail rounded-ee-bubble-tail',
  },
} as const;

/*
  The bubble's padding, radius and type. Inside the help centre a bubble is
  read rather than scanned, so it takes the reading size, and Arabic the extra
  leading its marks need — the design system's `.kb-shell .sb-chat-bubble`,
  keyed off the shell so the portal does not have to ask for it.
*/
const BUBBLE_BOX =
  'relative max-w-full rounded-bubble border px-(--bubble-pad-x) py-(--bubble-pad-y) text-sm leading-[1.65] wrap-anywhere in-[.kb-shell]:text-read-ui in-[.kb-shell]:leading-[1.75] in-[.kb-shell]:[&:lang(ar)]:leading-read-ar';

export function ChatBubble({
  from = 'in',
  kind = 'message',
  shape = 'round',
  group = 'single',
  wide = false,
  author,
  badge,
  avatar,
  time,
  receipt,
  receiptLabel,
  reactions,
  error,
  extra,
  lang,
  children,
}: ChatBubbleProps) {
  const out = from === 'out';
  const head = (group === 'single' || group === 'first') && (author || badge);
  const foot = group === 'single' || group === 'last';
  const joined = group === 'middle' || group === 'last';
  const r = receipt ? RECEIPTS[receipt] : null;

  const bubble =
    kind === 'attachment'
      ? 'max-w-full'
      : `${BUBBLE_BOX} ${
          kind === 'note' ? BUBBLE_TONE.note : kind === 'bot' ? BUBBLE_TONE.bot : BUBBLE_TONE[from]
        } ${shape === 'tail' ? TAIL[from][group] : ''}`;

  return (
    <li
      className={`flex w-full items-end gap-2 first:mt-0 [[data-chat-event]+&]:mt-0 ${
        joined ? 'mt-0.5' : 'mt-3.5'
      } ${out ? 'flex-row-reverse' : ''}`}
    >
      {avatar !== undefined ? (
        <span className="flex w-(--bubble-avatar) shrink-0">{foot ? avatar : null}</span>
      ) : null}

      <div
        className={`flex min-w-0 flex-col gap-1 ${
          wide ? 'max-w-[min(46rem,90%)]' : 'max-w-[min(var(--bubble-max),78%)]'
        } ${out ? 'items-end' : 'items-start'}`}
      >
        {head ? (
          <div
            className={`flex flex-wrap items-center gap-1.5 px-1 text-xs font-semibold ${
              kind === 'note' ? 'text-(--color-message-note-fg)' : 'text-(--color-text-secondary)'
            }`}
          >
            {kind === 'note' ? <LockIcon size={13} className="shrink-0" /> : null}
            {kind === 'bot' ? <BotIcon size={14} className="shrink-0" /> : null}
            {author ? <span dir="auto">{author}</span> : null}
            {badge}
          </div>
        ) : null}

        {/*
          The reactions overlap the bubble's foot by half their height,
          so they read as attached to it, and sit on the side away from the
          sender: that corner is never the tail, and on a short bubble the
          avatar's side is where the eye already is. Wrapped so `self-*` is
          measured against the bubble, not against a wider error or receipt.

          The wrapper is there with or without reactions. Drawn only when
          there were some, the first 👍 to arrive changed the tree above the
          message's body, and React remounted it: a voice note an agent was
          playing stopped, and an opened photo closed.
        */}
        <div className={`flex max-w-full min-w-0 flex-col ${out ? 'items-end' : 'items-start'}`}>
          <div className={bubble}>
            <div dir="auto" lang={lang} className="text-start font-conversation">
              {children}
            </div>
          </div>
          {reactions ? (
            <div
              className={`relative -mt-3 flex flex-wrap gap-1 px-2.5 ${out ? 'self-start' : 'self-end'}`}
            >
              {reactions}
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="flex items-start gap-1 px-1 text-start text-xs text-(--color-feedback-danger-fg)">
            <AlertCircleIcon size={14} className="mt-px shrink-0" />
            <span className="whitespace-pre-wrap">{error}</span>
          </p>
        ) : null}

        {extra}

        {foot && (time || r) ? (
          <p className="flex items-center gap-2 px-1 text-xs text-(--color-text-secondary) tabular-nums">
            {time}
            {r ? (
              <span
                className={`inline-flex items-center gap-0.75 ${
                  receipt === 'read' ? 'text-(--color-text-brand)' : ''
                }`}
              >
                <r.icon size={14} />
                {receiptLabel ?? r.label}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * One reaction, as the pill `ChatBubble` pins to a message.
 *
 * `mine` is the viewer's side — the team's in the console — in the design
 * system's blue wash, so an agent can tell the customer's 🙏 from the one the
 * business sent back from its phone. The wash is not the only signal: `glyph`
 * puts the reactor's mark beside the emoji (the console uses the same glyph as
 * the reactor's tile in the thread), because the side a pill sits on says
 * nothing about who reacted — customers react to their own messages too. Who
 * and when, in words, is the caller's: the console wraps the pill in a
 * `Tooltip` whose label is that sentence.
 *
 * The emoji is the customer's content, not an icon, so it is drawn in the
 * platform's emoji face rather than replaced by one of ours.
 */
export function ChatReaction({
  emoji,
  mine = false,
  glyph,
}: {
  emoji: string;
  mine?: boolean;
  /** A small icon before the emoji, in the pill's own ink. */
  glyph?: ReactNode;
}) {
  return (
    <span
      className={`inline-flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-full border px-1.5 font-emoji text-sm leading-none ${
        mine
          ? 'border-(--color-reaction-mine-border) bg-(--color-reaction-mine-bg) text-(--color-reaction-mine-fg)'
          : 'border-(--color-reaction-border) bg-(--color-reaction-bg) text-(--color-reaction-fg)'
      }`}
    >
      {glyph}
      {emoji}
    </span>
  );
}

/**
 * A line across the thread: a day break, or something that happened — assigned,
 * resolved, the window closing. Never a bubble, because nobody said it, and a
 * system notice drawn as the customer's message is how one came to be read as
 * the customer's words.
 */
export function ChatEvent({
  variant = 'system',
  children,
}: {
  variant?: 'system' | 'day';
  children: ReactNode;
}) {
  return (
    <li
      data-chat-event
      className={`mt-4.5 mb-3.5 flex items-center gap-2.5 text-center text-xs first:mt-0 before:h-px before:flex-1 before:bg-(--color-border-subtle) after:h-px after:flex-1 after:bg-(--color-border-subtle) ${
        variant === 'day'
          ? 'font-semibold text-(--color-text-primary)'
          : 'text-(--color-text-secondary)'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">{children}</span>
    </li>
  );
}
