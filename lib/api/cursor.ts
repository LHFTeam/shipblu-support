import { createHmac } from 'node:crypto';
import { safeEqual } from '@/lib/auth/tokens';
import { env } from '@/lib/env';
import { isUuid } from '@/lib/http/uuid';

/**
 * The myBlu API's page boundaries (`plans/myblu-ticket-api.md`, _Reading without
 * a stream_): opaque to the app, base64url of Postgres's own timestamp text and
 * the row's id — the inbox's form (`encodeInboxCursor`), so one argument holds
 * for both — and a signature over the two. A JS `Date` keeps milliseconds where
 * `timestamptz` keeps microseconds, and a cursor that went through one would
 * compare against an instant a few microseconds before its row: the next page
 * would hand back a row already shown, or skip the one beside it. The text
 * Postgres printed goes back to it as it came, behind `::timestamptz`.
 *
 * A cursor this server did not mint is refused, never read as a first page: a
 * client that sent one is holding something wrong, and the newest page in its
 * place would look like a thread that had lost its history. "Did not mint" is
 * checked, not approximated: the cursor carries an HMAC of its text under
 * `APP_SECRET`, with a purpose of its own in what is signed, as a widget's file
 * link does (`lib/widget/file-links.ts`), so no other signature the secret
 * makes stands in for one. Judged by its spelling alone, any base64url of a
 * timestamp and a uuid was read as a page from wherever it named — harmless,
 * since every read still carries the caller's own ticket in its `where`, but a
 * cursor built by hand is exactly what the refusal is for. The cost is that a
 * change of `APP_SECRET` refuses every cursor an app holds, once each: the SDK
 * drops a refused cursor and reads the newest page (`invalid_cursor` in the
 * guide's table), merging by id, so a thread loses nothing.
 *
 * Unbound to its ticket, as the guide promises nothing more than "minted here":
 * one ticket's cursor sent for another of the same user's reads that ticket
 * from the instant it names. Bound to its kind, though (`CursorKind`): a
 * thread's and the tickets list's cursors carry the same two things, a
 * timestamp and a uuid, and read as the other one would page from a message's
 * `created_at` on a ticket's `last_message_at`, or the other way round — a
 * page from an instant that says nothing about the rows it is compared with.
 * So each signs under a purpose of its own, and one sent where the other is
 * read is refused like any cursor this server did not mint. The kind is a
 * required argument on both sides, so no page can mint or read a cursor
 * without saying which.
 *
 * What a cursor carries is also refused when Postgres could not read it back,
 * before a query rather than by Postgres, because the text goes into the
 * statement: a timestamp Postgres cannot read is 22007 or 22008, a `500` for
 * what is the client's `400 invalid_cursor`. Only the secret can sign such a
 * text, so the check costs a regex and decides nothing today; it is kept so
 * that the statement never depends on the secret alone.
 */

export type Cursor = { time: string; id: string };

/** Which pages a cursor bounds: a thread's messages, or the user's tickets. */
export type CursorKind = 'messages' | 'tickets';

/**
 * What each kind signs under. `messages` is stage 4's, unchanged, so a
 * thread's cursor an app already holds still reads. Neither is a prefix of the
 * other, so no text one signs is a text the other signs.
 */
const PURPOSES: Record<CursorKind, string> = {
  messages: 'myblu-messages-cursor',
  tickets: 'myblu-tickets-cursor',
};

/**
 * Postgres's ISO output for a `timestamptz`, as the pool's sessions print it:
 * `2026-11-12 09:41:07.004213+00`. The fraction is left out when it is zero and
 * cut of its trailing zeros otherwise, and the offset is the session's zone's,
 * hours and, where it has them, minutes and seconds. Nothing else is one we
 * printed.
 */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::(\d{2})(?::(\d{2}))?)?$/;

function signature(kind: CursorKind, cursor: Cursor, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${PURPOSES[kind]}:${cursor.time}|${cursor.id}`)
    .digest('base64url');
}

/**
 * The cursor a page of `kind` answers, signed. `secret` is `APP_SECRET`
 * everywhere but the published document's example (`lib/api/openapi.ts`),
 * which is built without the environment and signs under a key no server
 * holds.
 */
export function encodeCursor(
  kind: CursorKind,
  cursor: Cursor,
  secret: string = env().APP_SECRET,
): string {
  const text = `${cursor.time}|${cursor.id}|${signature(kind, cursor, secret)}`;
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * The cursor a value names, or null for one this server did not mint for a
 * page of `kind` — another kind's included.
 */
export function decodeCursor(kind: CursorKind, value: string): Cursor | null {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  // Only the spelling this server writes: Node's decoder skips characters
  // outside the alphabet and ignores stray padding bits, so without this a
  // cursor with something added to it decoded as if it had none.
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return null;

  // Neither the timestamp, the uuid nor a base64url signature holds a `|`.
  const [time, id, given, ...rest] = decoded.split('|');
  if (time === undefined || id === undefined || given === undefined || rest.length > 0) {
    return null;
  }
  const cursor = { time, id };
  if (!safeEqual(given, signature(kind, cursor, env().APP_SECRET))) return null;
  if (!isUuid(id) || !isPrintedTimestamp(time)) return null;
  return cursor;
}

/**
 * Whether `text` is a timestamp Postgres printed: its shape, and a date and a
 * time that exist. The second because the shape alone passes `2026-02-30`,
 * which Postgres refuses as out of range.
 */
function isPrintedTimestamp(text: string): boolean {
  const match = TIMESTAMP.exec(text);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes, offsetSeconds] = match
    .slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    offsetHours! <= 15 &&
    offsetMinutes! <= 59 &&
    offsetSeconds! <= 59
  );
}

/**
 * The boundary of a thread with no row before it: the cursor a page answers as
 * `newerCursor` when it has nothing to name, which the contract says is never
 * null. Before every row any ticket can hold, so `after` it reads the thread
 * from its start.
 */
export const THREAD_START: Cursor = {
  time: '1970-01-01 00:00:00+00',
  id: '00000000-0000-0000-0000-000000000000',
};
