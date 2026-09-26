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

export function initials(name: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
