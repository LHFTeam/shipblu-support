import { FILTERABLE_CHANNELS, type FilterableChannel } from './channel-policy';

export type InboxFilters = {
  view: 'all' | 'mine' | 'unassigned';
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed' | 'all' | 'unresolved';
  channel: 'all' | 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'whatsapp_bot';
  q: string;
};

export const PAGE_SIZE = 30;

/**
 * Where a page of the inbox stops, as a keyset rather than an offset.
 *
 * The inbox is sorted by most recent activity and reorders itself constantly —
 * every inbound message moves a conversation to the top. Under `OFFSET 30` that
 * shuffling is silent corruption: rows pushed past the boundary between two
 * requests are served twice, and rows that move up are skipped entirely. An
 * agent scrolling a busy queue would see duplicates and, worse, never see the
 * tickets that slipped through the gap.
 *
 * A keyset asks for "older than this exact row" instead, which is stable no
 * matter what happens above it. Rows that move up are simply re-sorted into the
 * live first page, where the list dedupes them by id.
 *
 * `lastMessageAt` alone is not unique, so the row's id is carried as a
 * tiebreaker and both are compared as a tuple.
 */
export type InboxCursor = { time: string; id: string };

/**
 * The timestamp travels as the text Postgres printed rather than as a JS Date.
 *
 * `Date` holds milliseconds and `timestamptz` holds microseconds, so a cursor
 * that round-tripped through `Date` would compare against a value a few
 * microseconds earlier than the row it names — and the tuple comparison would
 * then hand back a row that has already been shown, or skip its neighbour.
 * Keeping the original text keeps the comparison exact.
 */
export function encodeInboxCursor(cursor: InboxCursor): string {
  return Buffer.from(`${cursor.time}|${cursor.id}`, 'utf8').toString('base64url');
}

export function parseInboxCursor(value: string | null | undefined): InboxCursor | null {
  if (!value) return null;

  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  // Split on the first separator only: the timestamp cannot contain one, but
  // refusing to guess keeps a malformed cursor from becoming a malformed query.
  const separator = decoded.indexOf('|');
  if (separator < 1) return null;

  const time = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!time || !UUID_PATTERN.test(id)) return null;

  return { time, id };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFilters(params: Record<string, string | string[] | undefined>): InboxFilters {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const view = one('view');
  const statusCategory = one('status');
  const channel = one('channel');

  return {
    view: view === 'mine' || view === 'unassigned' ? view : 'all',
    statusCategory:
      statusCategory === 'open' ||
      statusCategory === 'pending' ||
      statusCategory === 'resolved' ||
      statusCategory === 'closed' ||
      statusCategory === 'all'
        ? statusCategory
        : 'unresolved',
    // Every value the dropdown offers has to be listed, or selecting it falls
    // through to 'all' and the filter silently does nothing.
    channel: FILTERABLE_CHANNELS.includes(channel as FilterableChannel)
      ? (channel as FilterableChannel)
      : 'all',
    q: (one('q') ?? '').trim(),
  };
}
