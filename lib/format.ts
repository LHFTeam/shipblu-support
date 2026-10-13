/**
 * Display helpers shared by the console.
 *
 * Everything renders in Africa/Cairo regardless of where the agent's browser
 * thinks it is: the team is one office, and a timestamp that differs between
 * two agents looking at the same ticket causes real confusion during handover.
 */

import { TEAM_TIME_ZONE } from '@/lib/hours/zone';

export function formatDateTime(value: Date | string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TEAM_TIME_ZONE,
  }).format(new Date(value));
}

/*
  The ticket thread's two halves of a timestamp: a day break above the first
  entry of each Cairo day, and a bare time under each message, in place of the
  full date and time every message used to carry. Lossless only because the
  break goes in on every change of day — before a side card as well as a
  message — and in the team's zone rather than the browser's, so two agents
  read the same day, and the server's render and the browser's agree on where
  the breaks fall. Built on first use and kept: the thread formats every
  message with them, but this module is imported by every console page for
  `formatRelative`, and a formatter with a time zone is not free to construct
  where nothing will call it.
*/
let day: Intl.DateTimeFormat | undefined;
let time: Intl.DateTimeFormat | undefined;

/** "Saturday, 29 August 2026" — the day an instant falls on in Cairo. */
export function formatDay(at: Date): string {
  day ??= new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TEAM_TIME_ZONE,
  });
  return day.format(at);
}

/** "09:05" — the Cairo wall-clock time of an instant, always two digits, never 24:00. */
export function formatTime(at: Date): string {
  time ??= new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TEAM_TIME_ZONE,
  });
  return time.format(at);
}

/** "3m", "4h", "2d" — the inbox needs recency at a glance, not precision. */
export function formatRelative(value: Date | string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  return formatDateTime(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function channelLabel(channel: string): string {
  return { email: 'Email', whatsapp: 'WhatsApp', webchat: 'Web chat' }[channel] ?? channel;
}

/**
 * An enum value as a badge or table label: "agents_only" → "Agents only". The
 * design system's labels are sentence case, and the values come from the
 * database in lower snake case; one helper rather than the expression inlined
 * at every badge, so a label that forgets it is the one that stands out.
 */
export function sentenceCase(text: string): string {
  const spaced = text.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
