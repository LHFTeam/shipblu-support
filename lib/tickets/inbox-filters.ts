import { FILTERABLE_CHANNELS, type FilterableChannel } from './channel-policy';

/**
 * What an inbox URL may ask for, and where a page of results stops.
 *
 * No database here, which is why it is its own module: the console list takes
 * `InboxFilters` from it without reaching `db/schema`. It is not all
 * browser-safe, though. The two cursor functions use Node's `Buffer`, and only
 * server code calls them today; a client file importing one would compile, and
 * fail only when it ran.
 */

export type InboxFilters = {
  /** `groups`: tickets in the groups the agent belongs to, whoever holds them. */
  view: 'all' | 'mine' | 'unassigned' | 'groups';
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed' | 'all' | 'unresolved';
  channel: 'all' | FilterableChannel;
  /**
   * `low`: only tickets a customer rated `LOW_RATING_MAX` or lower in the last
   * `RATED_LOW_DAYS` days (`ratedLowRecently`). No select offers it; the
   * "Rated 1–2" view does, and the list says so while it is on.
   */
  rating: 'any' | 'low';
  /**
   * One group's tickets, by id, or null for every group. A group view sets it;
   * no select does. `listInbox` applies it inside visibility, so naming a group
   * the agent cannot see returns nothing rather than widening anything.
   */
  group: string | null;
  /**
   * One ticket category's tickets, by id, or null for every ticket, with a
   * category or without. The Category select sets it; no view does, because
   * the select already offers every category, and a view per category is
   * worth its place in the column only once a category decides a ticket's
   * group (Stage 5). A retired category's id still filters, so a link to one
   * keeps meaning what it said.
   */
  category: string | null;
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

/**
 * A query string in the shape Next hands a page its `searchParams`: every value
 * of a repeated key, in order.
 *
 * For `/api/inbox`, which serves the pages the list scrolls to and must read
 * the filters exactly as the page that drew the first one did. It read them
 * through `Object.fromEntries`, which keeps the last of a repeated key where
 * `parseFilters` takes the first, so a link carrying two categories listed one
 * on the first page and appended the other's tickets beneath it, under a
 * select naming the first. Handing over every value leaves the choice to
 * `parseFilters` on both paths.
 */
export function queryParams(search: URLSearchParams): Record<string, string[]> {
  const params: Record<string, string[]> = {};
  for (const [key, value] of search) (params[key] ??= []).push(value);
  return params;
}

export function parseFilters(params: Record<string, string | string[] | undefined>): InboxFilters {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const view = one('view');
  const statusCategory = one('status');
  const channel = one('channel');
  const rating = one('rating');
  const group = one('group');
  const category = one('category');

  return {
    view: view === 'mine' || view === 'unassigned' || view === 'groups' ? view : 'all',
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
    rating: rating === 'low' ? 'low' : 'any',
    // Checked here rather than left to Postgres, which answers a malformed uuid
    // with 22P02 — a page that fails rather than a list that is empty.
    group: group && UUID_PATTERN.test(group) ? group.toLowerCase() : null,
    // An id rather than a key, as the column is: the select's options are rows,
    // and a key would cost the query a join to say the same thing.
    category: category && UUID_PATTERN.test(category) ? category.toLowerCase() : null,
    q: (one('q') ?? '').trim(),
  };
}
