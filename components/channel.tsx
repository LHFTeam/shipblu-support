import type { ReactNode } from 'react';

/**
 * Channel identity in one place.
 *
 * An agent working a mixed inbox is switching between five sets of rules — a
 * 24-hour WhatsApp window, a 7-day Messenger one, a public Facebook comment —
 * and the channel is the single most useful thing to be able to see without
 * reading. So each gets its own mark and its own colour, and both come from
 * here rather than being re-invented per screen.
 *
 * The colours are the platforms' own, which is what makes them recognisable
 * without a legend; they are used at low opacity so a list of them still reads
 * as one interface rather than as a row of logos.
 */

export type Channel = string;

const CHANNELS: Record<string, { label: string; className: string; mark: ReactNode }> = {
  email: {
    label: 'Email',
    className: 'bg-slate-500/15 text-slate-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <rect x="3" y="5.5" width="18" height="13" rx="2" />
        <path d="m4 7 8 6 8-6" />
      </svg>
    ),
  },
  whatsapp: {
    label: 'WhatsApp',
    className: 'bg-emerald-500/15 text-emerald-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-3">
        <path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.3A10 10 0 1 0 12 2zm5.5 14.1c-.2.6-1.2 1.2-1.7 1.2-.5.1-1 .1-1.6-.1a12 12 0 0 1-6.5-5.7c-.5-.9-.8-1.9-.1-2.8.2-.3.5-.5.8-.5h.6c.2 0 .4 0 .6.5l.8 1.9c.1.2 0 .4-.1.6l-.4.5c-.1.2-.3.3-.1.6a8.8 8.8 0 0 0 3.8 3.3c.3.1.5.1.7-.1l.7-.8c.2-.2.3-.2.6-.1l1.8.9c.3.1.4.2.4.4v.8z" />
      </svg>
    ),
  },
  whatsapp_bot: {
    // Its own label and colour, not a variant of the WhatsApp badge. An agent
    // scanning a list has to be able to tell at a glance that a row is a
    // transcript they cannot answer from one that is waiting on them, and a
    // green badge with different wording is not that glance.
    label: 'Customer bot',
    className: 'bg-violet-500/15 text-violet-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <rect x="4" y="8" width="16" height="11" rx="3" />
        <path d="M12 8V4.5" />
        <circle cx="9" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  webchat: {
    label: 'Web chat',
    className: 'bg-brand-500/15 text-brand-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <path d="M20 12.5c0 3.6-3.6 6.5-8 6.5-1 0-2-.15-2.9-.42L4 20l1.3-3.5C4.5 15.4 4 14 4 12.5 4 8.9 7.6 6 12 6s8 2.9 8 6.5z" />
      </svg>
    ),
  },
  facebook: {
    label: 'Facebook',
    className: 'bg-blue-500/15 text-blue-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="size-3">
        <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 22 12z" />
      </svg>
    ),
  },
  instagram: {
    label: 'Instagram',
    className: 'bg-pink-500/15 text-pink-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
        <circle cx="12" cy="12" r="3.6" />
        <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  portal: {
    label: 'Portal',
    className: 'bg-slate-500/15 text-slate-700',
    mark: null,
  },
  api: {
    label: 'API',
    className: 'bg-slate-500/15 text-slate-700',
    mark: null,
  },
  mobile: {
    // The myBlu consumer app. Its own colour rather than web chat's, because
    // the thing an agent needs at a glance is that this person is holding a
    // phone: the reply lands in an app they may not have open, and there is no
    // email address behind it to fall back to.
    label: 'myBlu app',
    className: 'bg-sky-500/15 text-sky-700',
    mark: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
        <path d="M10.5 18.5h3" />
      </svg>
    ),
  },
};

export function channelInfo(channel: Channel) {
  return (
    CHANNELS[channel] ?? {
      label: channel,
      className: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
      mark: null,
    }
  );
}

export function ChannelBadge({
  channel,
  showLabel = true,
}: {
  channel: Channel;
  showLabel?: boolean;
}) {
  const info = channelInfo(channel);

  return (
    <span
      title={info.label}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${info.className}`}
    >
      {info.mark}
      {showLabel ? info.label : null}
    </span>
  );
}
