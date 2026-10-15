/**
 * Display helpers shared by the console.
 *
 * Everything renders in Africa/Cairo regardless of where the agent's browser
 * thinks it is: the team is one office, and a timestamp that differs between
 * two agents looking at the same ticket causes real confusion during handover.
 */

import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import type { Locale } from '@/lib/kb/locale';

/**
 * An instant written from the fields a formatter reads off it, joined by
 * `join` rather than by the punctuation the formatter would put between them.
 *
 * Every format here is put together this way rather than taken whole,
 * because the punctuation is locale data and the two ends of a render carry
 * different copies of it: Node 22's ICU (CLDR 47) writes `en-GB`'s long day as
 * "Wednesday, 14 October 2026" and Chromium 141's as "Wednesday 14 October
 * 2026". A client component draws these on the server and again in the
 * browser, so that comma was a hydration error on every ticket page, and React
 * threw the server's HTML away and rebuilt the whole page in the browser. The
 * names and numbers are the engine's — those it has to supply — and the
 * separators are ours, so the next browser or Node release cannot bring the
 * rebuild back through a format that only agreed by measurement.
 *
 * An engine that leaves out a field `join` needs — a runtime built without the
 * full locale data — gets its own whole string back: a mismatch the page can
 * survive, where the word "undefined" in every day break would be a bug on
 * screen.
 */
function joined<K extends Intl.DateTimeFormatPartTypes>(
  format: Intl.DateTimeFormat,
  at: Date,
  needs: readonly K[],
  join: (part: Record<K, string>) => string,
): string {
  const part: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of format.formatToParts(at)) part[type] = value;
  return needs.every((key) => part[key]) ? join(part as Record<K, string>) : format.format(at);
}

let dateTime: Intl.DateTimeFormat | undefined;

/** "14 Oct 2026, 09:05" — an instant in Cairo, to the minute. */
export function formatDateTime(value: Date | string): string {
  dateTime ??= new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TEAM_TIME_ZONE,
  });
  return joined(
    dateTime,
    new Date(value),
    ['day', 'month', 'year', 'hour', 'minute'],
    (part) => `${part.day} ${part.month} ${part.year}, ${part.hour}:${part.minute}`,
  );
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
  return joined(
    day,
    at,
    ['weekday', 'day', 'month', 'year'],
    (part) => `${part.weekday}, ${part.day} ${part.month} ${part.year}`,
  );
}

/** "09:05" — the Cairo wall-clock time of an instant, always two digits, never 24:00. */
export function formatTime(at: Date): string {
  time ??= new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TEAM_TIME_ZONE,
  });
  return joined(time, at, ['hour', 'minute'], (part) => `${part.hour}:${part.minute}`);
}

let input: Intl.DateTimeFormat | undefined;

/**
 * "2026-10-14T09:05" — an instant as the Cairo wall clock a `datetime-local`
 * input takes, which wants exactly `yyyy-MM-ddTHH:mm` where every locale's own
 * rendering is something else. `h23` because `hour12: false` reads midnight as
 * 24 in some ICU versions, which the input refuses.
 */
export function formatInputDateTime(at: Date): string {
  input ??= new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: TEAM_TIME_ZONE,
  });
  return joined(
    input,
    at,
    ['year', 'month', 'day', 'hour', 'minute'],
    (part) => `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`,
  );
}

/*
  The chat widget's "we reply from" time, in the visitor's language. The widget
  is drawn on the server and hydrated in whatever browser the visitor has —
  Safari and Firefox carry locale data of their own, not Chromium's — so it is
  joined like the console's formats rather than taken whole. The hour cycle is
  stated rather than left to the locale's default, which is locale data too:
  Arabic reads the twelve-hour clock with ص/م, English the twenty-four-hour one.
*/
const opens: Partial<Record<Locale, Intl.DateTimeFormat>> = {};

/** "Sun 09:00", "الأحد ٠٩:٠٠ ص" — when the team next answers, in Cairo. */
export function formatOpens(at: Date | string, locale: Locale): string {
  const format = (opens[locale] ??= new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: locale === 'ar' ? 'h12' : 'h23',
    timeZone: TEAM_TIME_ZONE,
  }));
  const twelveHour = locale === 'ar';
  return joined(
    format,
    new Date(at),
    twelveHour ? ['weekday', 'hour', 'minute', 'dayPeriod'] : ['weekday', 'hour', 'minute'],
    (part) =>
      `${part.weekday} ${part.hour}:${part.minute}${twelveHour ? ` ${part.dayPeriod}` : ''}`,
  );
}

/**
 * "3m", "4h", "2d" — the inbox needs recency at a glance, not precision.
 *
 * The clock is an argument, and a required one, because which clock is the
 * whole question. A server component passes the instant it renders at. A
 * client component draws on the server and again in the browser, a moment and
 * possibly a minute boundary later, so it cannot read the clock during either:
 * it renders `<RelativeTime>`, which formats against `useNow()` once the page
 * has hydrated. Reading `Date.now()` in here made every caller's text depend on
 * when it rendered, which is the hydration error §6.96 records.
 */
export function formatRelative(value: Date | string, now: Date): string {
  const elapsed = now.getTime() - new Date(value).getTime();
  const minutes = Math.floor(elapsed / 60_000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  return formatDateTime(value);
}

/**
 * `formatRelative`'s answer as the end of a sentence: "3m ago", "just now", or
 * the date itself.
 *
 * `formatRelative` answers "now" inside the first minute and an absolute date
 * past a month, and neither takes the "ago" a duration does: a line built as
 * `Opened ${relative} ago` read "Opened now ago" on every new ticket, and would
 * read "Opened 3 Jul 2026, 14:02 ago" on one old enough to matter. Nor does a
 * bare duration belong in a sentence — "Last changed 3m" reads as how long the
 * change took. The inbox column keeps the bare shorthand; prose takes this.
 */
export function ago(relative: string): string {
  if (relative === 'now') return 'just now';
  return /^\d+[mhd]$/.test(relative) ? `${relative} ago` : relative;
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
