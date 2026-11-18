import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { alias, unionAll, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import { db } from '@/db/client';
import {
  apiTickets,
  attachments,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { ATTACHMENT_URL_TTL_SECONDS } from '@/lib/attachments/signed-url';
import { webchatFilesStandIn } from '@/lib/chat/stand-ins';
import { isUniqueViolation } from '@/lib/db/errors';
import { preview } from '@/lib/html/sanitize';
import type { Admission } from '@/lib/http/rate-limit';
import { logger, scrubbed } from '@/lib/log';
import { shownLabelSql } from '@/lib/portal/tickets';
import { planRouting, routingWindowValues, startRouting } from '@/lib/routing/start';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import { signedUrl } from '@/lib/storage';
import { subjectWords, UNNAMED_SUBJECT } from '@/lib/tickets/customer-text';
import { latest } from '@/lib/tickets/latest';
import { isMediaStandIn } from '@/lib/tickets/message-media';
import { notReaction } from '@/lib/tickets/not-reaction';
import { reopenResolved } from '@/lib/tickets/reopen';
import { lockedStatusCategory, statusCategoryOf } from '@/lib/tickets/status-category';
import { requireDefaultOpenStatusId } from '@/lib/tickets/statuses';
import { isUuid } from '@/lib/http/uuid';
import {
  attachmentRows,
  discardPaths,
  releaseUnlessStored,
  storeVisitorFiles,
  VisitorUploadFailed,
  webchatFilesMeta,
  type StoredUpload,
  type VisitorUpload,
} from '@/lib/widget/conversation';
import { afterPage } from './after-page';
import { apiChannel } from './channel';
import { encodeCursor, THREAD_START, type Cursor } from './cursor';
import { finishInRequest, oweFinish } from './finish';
import { messageFrom } from './from';
import { admitNewTicket, MAX_OPEN_TICKETS, newTicketFits, spendUpload, uploadFits } from './limits';
import { previewText } from './preview';
import { trackingFoldSql } from './tracking-fold';
import type { AttachmentLink, Message, Ticket } from './schemas';
import { ownedTicket, ownedTicketNow } from './scope';
import { holdAccount, requesterNow, type Caller } from './sessions';

/**
 * The myBlu app's tickets (`plans/myblu-ticket-api.md`, _What the app can
 * read_, _Tickets_, _Idempotency_, _Reading without a stream_): opening one,
 * writing on one, and reading them back.
 *
 * **Every function that reaches a ticket takes the caller first, and every
 * statement about a ticket carries `ownedTicket(caller)` in the same `WHERE` as
 * the ticket's id.** There is no read here by id alone, so a ticket that is not
 * this user's — another identity's, another channel's, deleted, spam or merged
 * — is one answer from one query, and a route has nothing to compare
 * afterwards. The one export without a caller, `customerWrote`, is the `SET`
 * of a write whose `WHERE` the locked read already scoped.
 *
 * **Messages are replies, in the query.** `kind = 'reply'` and `notReaction()`
 * are in every statement that reads them, so a note, a system row or a forward
 * is never in the payload to leak, and only `body_text` is read for what a
 * message says: never `body_html`, `raw_body`, an address, or `meta` beyond
 * what decides the answer. A ticket and a message are named field lists built
 * fresh here, as `publicTracking()` builds its answer, so a column added to
 * either table cannot ride along.
 *
 * **Unread is one predicate, `unreadReply()`**: what `unreadCount` and
 * `unreadTotal` count and what `POST /tickets/{id}/read` clears. That marker
 * (`markTicketRead`) is the only writer of `messages.read_at` on `api`, and it
 * never moves or unsets one.
 */

const log = logger('api_tickets');

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type TicketView = z.input<typeof Ticket>;
type MessageView = z.input<typeof Message>;

/**
 * The two requests that write a message, by the names the document gives them.
 * Recorded on the message (`meta.apiOperation`), because a key replayed against
 * the other one is `409 key_reused`, and the message is the only record the
 * key has.
 */
type Operation = 'createTicket' | 'sendMessage';

/** `messages.channel_message_id` for a key: namespaced by the session's identity (`keyOf`). */
const KEY_PREFIX = 'api:';

/**
 * Namespaced, because the column's unique index covers the whole table, so a
 * bare client UUID would share a keyspace with every wamid and Message-ID; and
 * by the identity, taken from the session, so one user can neither collide with
 * nor probe another's key. Stored as the client sent it: the SDK matches the
 * `clientId` it reads back by string, and a platform's UUIDs can be upper-case.
 */
function keyOf(caller: Caller, key: string): string {
  return `${KEY_PREFIX}${caller.identityId}:${key}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A file on a message, as the read model names it. */
type StoredFile = { id: string; filename: string; contentType: string; sizeBytes: number };

/**
 * A message's files, as one JSON array in the statement that reads it — the
 * widget's `messageFiles`, for the reasons it gives: a join would spend a
 * page's `limit` on one message's photos. In the order sent, ties broken by
 * the stored key, which ends in the file's place. An inline image is part of a
 * body this API never sends, so it is left out.
 */
const messageFiles = sql<StoredFile[] | null>`(
  select json_agg(
    json_build_object(
      'id', ${attachments.id},
      'filename', ${attachments.filename},
      'contentType', ${attachments.contentType},
      'sizeBytes', ${attachments.sizeBytes}
    )
    order by ${attachments.createdAt}, ${attachments.storagePath}
  )
  from ${attachments}
  where ${attachments.messageId} = ${messages.id} and not ${attachments.isInline}
)`;

/** The columns of a message the read model decides from. */
type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  byAgent: boolean;
  bodyText: string;
  meta: Record<string, unknown>;
  channelMessageId: string | null;
  createdAt: Date;
  /** Postgres's own text for `created_at`, which a cursor carries (`lib/api/cursor.ts`). */
  cursorTime: string;
  /** `created_at` as digits that sort as it does (`AfterRow` in `./after-page`). */
  placeTime: string;
  files: StoredFile[] | null;
};

const messageColumns = {
  id: messages.id,
  direction: messages.direction,
  byAgent: sql<boolean>`${messages.authorAgentId} is not null`,
  bodyText: messages.bodyText,
  meta: messages.meta,
  channelMessageId: messages.channelMessageId,
  createdAt: messages.createdAt,
  cursorTime: sql<string>`${messages.createdAt}::text`,
  placeTime: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYYMMDDHH24MISSUS')`,
  files: messageFiles,
};

/**
 * Whether the text is only the stand-in written for the message's files
 * (`[image]`, `[2 attachments]`), which the API answers as `""`: `text` is
 * words somebody wrote, never a label of ours. The widget's own rule
 * (`standsIn` in `lib/widget/conversation.ts`), through the console's test
 * (`isMediaStandIn`), so the three surfaces leave out the same line.
 */
function standsIn(
  row: { direction: string; bodyText: string; meta: Record<string, unknown> },
  files: readonly { id: string; contentType: string }[],
): boolean {
  return (
    row.direction === 'inbound' &&
    files.length > 0 &&
    isMediaStandIn({ bodyText: row.bodyText, bodyHtml: null, meta: row.meta, attachments: files })
  );
}

/**
 * The `Idempotency-Key` the user's own message was sent under, on every read,
 * so an outbox recognises a message whose answer it never got. Only under this
 * session's identity's namespace: a key is never handed to anybody but the user
 * who made it.
 */
function clientIdOf(caller: Caller, row: MessageRow): string | null {
  const prefix = keyOf(caller, '');
  if (row.direction !== 'inbound' || !row.channelMessageId?.startsWith(prefix)) return null;
  const key = row.channelMessageId.slice(prefix.length);
  return isUuid(key) ? key : null;
}

function messageView(caller: Caller, row: MessageRow): MessageView {
  const files = row.files ?? [];
  return {
    id: row.id,
    from: messageFrom(row),
    text: standsIn(row, files) ? '' : row.bodyText,
    createdAt: row.createdAt.toISOString(),
    clientId: clientIdOf(caller, row),
    attachments: files.map(({ id, filename, contentType, sizeBytes }) => ({
      id,
      filename,
      contentType,
      sizeBytes,
    })),
  };
}

/** The newest reply the app may read, as `preview` is built from. */
type PreviewRow = {
  direction: 'inbound' | 'outbound';
  byAgent: boolean;
  bodyText: string;
  meta: Record<string, unknown>;
  files: StoredFile[] | null;
};

/**
 * The ticket's newest reply that is not a reaction, read by the thread's own
 * rules — a scalar subquery of the ticket's statement, so a list of tickets is
 * one statement however long it is.
 */
const previewSql = sql<PreviewRow | null>`(
  select json_build_object(
    'direction', ${messages.direction},
    'byAgent', ${messages.authorAgentId} is not null,
    'bodyText', ${messages.bodyText},
    'meta', ${messages.meta},
    'files', ${messageFiles}
  )
  from ${messages}
  where ${messages.conversationId} = ${conversations.id}
    and ${messages.kind} = 'reply'
    and ${notReaction()}
  order by ${messages.createdAt} desc, ${messages.id} desc
  limit 1
)`;

/**
 * The team's replies the user has not marked read: what `unreadCount` and
 * `unreadTotal` count and what `POST /tickets/{id}/read` marks, one predicate
 * so the badge and the marker cannot disagree. Outbound and `reply`, because a
 * note is an outbound row too; no `read_at`; and `notReaction()`, because a row
 * the thread never returns cannot be in a badge the user clears by reading it.
 * That last changes nothing on `api`, which has no reactions, and is there so
 * the marker and the badge stay one question if one ever arrives. Kept on the
 * server, so two devices and a reinstall show one badge.
 *
 * Over `messages` unaliased, which `notReaction()` names.
 */
function unreadReply(): SQL {
  return and(
    eq(messages.direction, 'outbound'),
    eq(messages.kind, 'reply'),
    isNull(messages.readAt),
    notReaction(),
  )!;
}

/** `unreadReply` on one ticket, a scalar subquery of the ticket's statement. */
const unreadCountSql = sql<number>`(
  select count(*)::int from ${messages}
  where ${messages.conversationId} = ${conversations.id} and ${unreadReply()}
)`;

/**
 * The tickets read a second time inside a read of one, for `unreadTotal`: an
 * alias, so the predicate names which `conversations` it is about.
 */
const owned = alias(conversations, 'owned');

/**
 * `unreadReply` across every ticket the user may read: the badge. It names no
 * ticket the outer statement reads, so inside one it is computed once (an
 * InitPlan), and it depends on no filter, cursor or page a list was asked for.
 */
function unreadTotalQuery(caller: Caller) {
  return db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(owned, eq(owned.id, messages.conversationId))
    .where(and(ownedTicket(caller, owned), unreadReply()));
}

function unreadTotalSql(caller: Caller): SQL<number> {
  return sql<number>`(${unreadTotalQuery(caller)})`;
}

/** The badge on its own, for an answer with no ticket row to carry it. */
async function readUnreadTotal(caller: Caller): Promise<number> {
  const [row] = await unreadTotalQuery(caller);
  return row?.count ?? 0;
}

/**
 * The tracking number the app claimed when it opened the ticket. A correlated
 * scalar subquery rather than a join, so `ownedTicket`'s `EXISTS` is the one
 * probe of `api_tickets` a read makes: joined, every five-second poll and every
 * send's answer read the table twice for one row.
 */
const trackingNumberSql = sql<
  string | null
>`(select ${apiTickets.trackingNumber} from ${apiTickets} where ${apiTickets.conversationId} = ${conversations.id})`;

const ticketColumns = {
  id: conversations.id,
  number: conversations.number,
  subject: conversations.subject,
  trackingNumber: trackingNumberSql,
  status: ticketStatuses.category,
  statusLabel: shownLabelSql,
  createdAt: conversations.createdAt,
  lastMessageAt: conversations.lastMessageAt,
  unreadCount: unreadCountSql,
  preview: previewSql,
};

type TicketRow = {
  id: string;
  number: number;
  subject: string | null;
  trackingNumber: string | null;
  status: TicketView['status'];
  statusLabel: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  unreadCount: number;
  preview: PreviewRow | null;
};

function ticketView(row: TicketRow): TicketView {
  const preview = row.preview;
  const previewFiles = preview?.files ?? [];
  return {
    id: row.id,
    number: row.number,
    // A ticket opened with a photo is called `[image]`, and one with nothing
    // to name it `myBlu app` (`UNNAMED_SUBJECT`): both are ours, and the app
    // draws its own title for null.
    subject: subjectWords(row.subject, 'api'),
    trackingNumber: row.trackingNumber,
    status: row.status,
    statusLabel: row.statusLabel,
    canReply: row.status !== 'closed',
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    unreadCount: row.unreadCount,
    preview: preview
      ? {
          from: messageFrom(preview),
          text: standsIn(preview, previewFiles) ? '' : previewText(preview.bodyText),
          hasAttachments: previewFiles.length > 0,
        }
      : null,
    // The survey's stage (stage 8) fills this in.
    survey: null,
  };
}

/**
 * One ticket the caller may read, by its id and `ownedTicket` in one `WHERE`,
 * and — for a poll, which answers it beside the ticket — the user's unread
 * badge in the same statement. Without it the badge is not counted at all.
 * On `executor`, so the read marker reads its answer inside its own
 * transaction, after its write: on the pool it would be a second connection
 * held by one request (§6.91).
 */
async function ownedTicketRow(
  caller: Caller,
  ticketId: string,
  { withTotal = false, executor = db }: { withTotal?: boolean; executor?: Executor } = {},
) {
  const [row] = await executor
    .select({
      ...ticketColumns,
      unreadTotal: withTotal ? unreadTotalSql(caller) : sql<number>`0`,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(eq(conversations.id, ticketId), ownedTicket(caller)))
    .limit(1);
  return row ?? null;
}

/** `GET /tickets/{id}`: one ticket the caller opened, or null for every reason it is not. */
export async function readTicket(caller: Caller, ticketId: string): Promise<TicketView | null> {
  const row = await ownedTicketRow(caller, ticketId);
  return row ? ticketView(row) : null;
}

/**
 * Which messages the caller may read, on any of their tickets: a reply, not a
 * reaction, on a ticket `ownedTicket(caller)` admits. A statement that reads
 * it joins `conversations` on the message's ticket.
 *
 * One predicate for a thread (`threadWhere`) and for a file fetched by its own
 * id (`attachmentLink`), so a message a thread stops listing is a message
 * whose files stop being served: written out twice, a condition added to the
 * thread — a withdrawn reply, say — would have left its files a request away.
 */
function readableMessage(caller: Caller): SQL {
  return and(ownedTicket(caller), eq(messages.kind, 'reply'), notReaction())!;
}

/** The replies of one ticket the caller may read, in the statement that names the ticket. */
function threadWhere(caller: Caller, ticketId: string, ...more: SQL[]): SQL {
  return and(eq(messages.conversationId, ticketId), readableMessage(caller), ...more)!;
}

function threadSelect(caller: Caller, ticketId: string, fresh: boolean, ...more: SQL[]) {
  return db
    .select({ ...messageColumns, fresh: sql<boolean>`${sql.raw(String(fresh))}` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(threadWhere(caller, ticketId, ...more));
}

/**
 * How far before its cursor `after` reads again. `created_at` is not commit
 * order — a message is stamped when its writer took its `now`, and committed
 * when its transaction ends — so a row stamped before the cursor can commit
 * after the page that minted it was read. Re-reading a few seconds back finds
 * it, and the client merges by `id`, so a row it holds already costs nothing
 * but bytes. The app's own writes take their `now` once they hold every lock
 * they wait on (`createApiTicket`, `sendApiMessage`), so what lies between
 * their stamp and their commit is their own statements, never a wait on a
 * merge or another request: stamped before the locks, a reply that waited out
 * a contact merge committed older than the overlap, behind a cursor another
 * device had already polled past, and no poll returned it.
 */
const AFTER_OVERLAP_SECONDS = 5;

/** Where a page reads from: the newest page, one before a cursor, or what is after one. */
export type PageAsked =
  | { kind: 'newest'; limit: number }
  | { kind: 'before'; cursor: Cursor; text: string; limit: number }
  | { kind: 'after'; cursor: Cursor; text: string; limit: number };

export type MessagesPage = {
  messages: MessageView[];
  olderCursor: string | null;
  newerCursor: string;
  ticket: TicketView;
  unreadTotal: number;
};

const cursorOf = (row: MessageRow): string =>
  encodeCursor('messages', { time: row.cursorTime, id: row.id });

/**
 * The row-value comparison with a cursor, its instant bound as the text
 * Postgres printed. A message's `(created_at, id)` unless the columns are
 * named — the list's are a ticket's `(last_message_at, id)` — so every page of
 * this API binds a cursor one way.
 */
function vsCursor(
  op: '<' | '>' | '<=',
  cursor: Cursor,
  time: AnyPgColumn = messages.createdAt,
  id: AnyPgColumn = messages.id,
): SQL {
  return sql`(${time}, ${id}) ${sql.raw(op)} (${cursor.time}::timestamptz, ${cursor.id}::uuid)`;
}

/**
 * A page read back from the newest row, or from before a cursor: newest first,
 * one row more than the page, so the caller knows whether anything is left.
 * Exported, with `afterStatement`, so a test can read the parameters each binds
 * (AGENTS.md, _Tests_): every instant goes in as the text Postgres printed.
 */
export function backStatement(
  caller: Caller,
  ticketId: string,
  asked: Extract<PageAsked, { kind: 'newest' | 'before' }>,
) {
  return threadSelect(
    caller,
    ticketId,
    false,
    ...(asked.kind === 'before' ? [vsCursor('<', asked.cursor)] : []),
  )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(asked.limit + 1);
}

/**
 * A poll after a cursor, in one statement of two halves: the rows after the
 * cursor, oldest first, up to the page; and the newest of those at or before it
 * within `AFTER_OVERLAP_SECONDS`, which `readMessages` lets fill only what the
 * page leaves. Each half's `ORDER BY` chooses the rows its `LIMIT` keeps, and
 * nothing more: the order they arrive in is `afterPage`'s to decide.
 */
export function afterStatement(
  caller: Caller,
  ticketId: string,
  asked: Extract<PageAsked, { kind: 'after' }>,
) {
  const newer = threadSelect(caller, ticketId, true, vsCursor('>', asked.cursor))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(asked.limit);
  const overlap = threadSelect(
    caller,
    ticketId,
    false,
    vsCursor('<=', asked.cursor),
    sql`${messages.createdAt} > ${asked.cursor.time}::timestamptz - ${sql.raw(`interval '${AFTER_OVERLAP_SECONDS} seconds'`)}`,
  )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(Math.max(asked.limit - 1, 1));
  return unionAll(newer, overlap);
}

/**
 * `GET /tickets/{id}/messages`: a page of the ticket's replies, ascending by
 * `(createdAt, id)` whichever way it was asked, with the ticket and the user's
 * unread badge. Null when the ticket is not the caller's to read.
 *
 * - **Newest**, with no cursor, rather than the thread's start: both existing
 *   read models are `orderBy(asc).limit(200)`, which silently stops showing a
 *   long conversation's new replies.
 * - **Before** a cursor pages back. One row more than the page is read, so
 *   `olderCursor` is null exactly when nothing is left before the page.
 * - **After** a cursor polls forward, re-reading `AFTER_OVERLAP_SECONDS`
 *   before it, in one statement of two halves: the rows after the cursor, up to
 *   the page, and the newest of those in the overlap. The overlap fills only what
 *   the page leaves, and never the page's last place, so a full page always
 *   means rows after the cursor are still unread and the cursor moved: filled
 *   by the overlap, a page whose cursor did not move would tell the client to
 *   ask again at once, for the same rows, for good. `newerCursor` is the newest
 *   row after the cursor, or the cursor itself, as it came, when nothing is;
 *   `olderCursor` is null, since a poll never pages back.
 */
export async function readMessages(
  caller: Caller,
  ticketId: string,
  asked: PageAsked,
): Promise<MessagesPage | null> {
  // The ticket and the badge in one statement, a poll's first.
  const ticket = await ownedTicketRow(caller, ticketId, { withTotal: true });
  if (!ticket) return null;
  const answer = (page: Omit<MessagesPage, 'ticket' | 'unreadTotal'>): MessagesPage => ({
    ...page,
    ticket: ticketView(ticket),
    unreadTotal: ticket.unreadTotal,
  });

  if (asked.kind === 'after') {
    const rows = await afterStatement(caller, ticketId, asked);
    const { page, newest } = afterPage(rows, asked.limit);
    return answer({
      messages: page.map((row) => messageView(caller, row)),
      // A poll never pages back. Its first row is as often one the overlap
      // re-read as the oldest after the cursor, so a cursor taken from it was
      // not null at the start of the thread, and a client offered "load older"
      // there paged back to nothing (the contract's `olderCursor`).
      olderCursor: null,
      newerCursor: newest ? cursorOf(newest) : asked.text,
    });
  }

  const rows = await backStatement(caller, ticketId, asked);
  const more = rows.length > asked.limit;
  const page = rows.slice(0, asked.limit).reverse();
  const first = page[0];
  const last = page.at(-1);
  return answer({
    messages: page.map((row) => messageView(caller, row)),
    olderCursor: more && first ? cursorOf(first) : null,
    newerCursor: last
      ? cursorOf(last)
      : asked.kind === 'before'
        ? asked.text
        : encodeCursor('messages', THREAD_START),
  });
}

/** One message the caller may read on one of their tickets, as a send answers it. */
async function readMessage(
  caller: Caller,
  ticketId: string,
  messageId: string,
): Promise<MessageView | null> {
  const [row] = await threadSelect(caller, ticketId, false, eq(messages.id, messageId)).limit(1);
  return row ? messageView(caller, row) : null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Which page of the list a request asks for (`listAsked`, `lib/api/requests.ts`). */
export type ListAsked = { cursor: Cursor | null; limit: number; trackingNumber: string | null };

export type TicketsListPage = {
  tickets: TicketView[];
  olderCursor: string | null;
  unreadTotal: number;
};

/**
 * A page of the caller's tickets, newest first by `(last_message_at, id)`,
 * one row more than the page so the caller knows whether anything is left,
 * every status, and only those opened with one tracking number when one is
 * asked for. The order and the `before` comparison change together, as the
 * inbox's do: the id breaks a tie on the instant, so a page boundary between
 * two tickets stamped alike neither repeats nor skips one.
 *
 * The identity is named on the joined ownership row as well as inside
 * `ownedTicket`, so the planner can drive from `api_tickets_identity_idx`, a
 * few rows per user, rather than walk every app ticket in
 * `conversations_channel_idx` order. `ownedTicket` stays whole: it is the one
 * copy of the scope, and the ownership row joined here is immutable, so naming
 * it twice can never disagree. The tracking number is matched on that same
 * row, and never read from `conversation_shipments`, which also holds numbers
 * an agent typed in a note; matched as the shipments code reads a number
 * everywhere (`normaliseTrackingNumber`), whatever its case and hyphens, since
 * a number typed in the composer as `sb-ab12` is the platform's `SB-AB12`
 * and a shipment screen asking with the one must find a ticket opened with
 * the other. Stored and answered as sent: only the comparison is folded, and
 * the stored side only as far as `TrackingNumber` lets it vary
 * (`trackingFoldSql`, whose test holds the two folds together).
 *
 * The badge rides in the same statement, uncorrelated and so computed once,
 * so it and every `unreadCount` on the page are one snapshot; it reads every
 * ticket the user may read, whatever the filter or the cursor. Exported so a
 * test can read the parameters it binds: the cursor's instant goes in as the
 * text Postgres printed, never through a `Date`.
 */
export function listStatement(caller: Caller, asked: ListAsked) {
  return db
    .select({
      ...ticketColumns,
      cursorTime: sql<string>`${conversations.lastMessageAt}::text`,
      unreadTotal: unreadTotalSql(caller),
    })
    .from(conversations)
    .innerJoin(apiTickets, eq(apiTickets.conversationId, conversations.id))
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        eq(apiTickets.identityId, caller.identityId),
        ownedTicket(caller),
        asked.trackingNumber === null
          ? undefined
          : sql`${trackingFoldSql(apiTickets.trackingNumber)} = ${normaliseTrackingNumber(asked.trackingNumber)}`,
        asked.cursor === null
          ? undefined
          : vsCursor('<', asked.cursor, conversations.lastMessageAt, conversations.id),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(asked.limit + 1);
}

/**
 * `GET /tickets`: a page of the caller's tickets with the user's unread badge.
 * One statement, and a second only for a page with no ticket on it — past the
 * last page, a tracking number matching nothing, a user with none — where no
 * row is there to carry the badge, which is then read on its own, still
 * unfiltered. Never null: a user with no tickets has an empty list, not a
 * missing one.
 */
export async function listTickets(caller: Caller, asked: ListAsked): Promise<TicketsListPage> {
  const rows = await listStatement(caller, asked);
  const more = rows.length > asked.limit;
  const page = rows.slice(0, asked.limit);
  const oldest = page.at(-1);
  return {
    tickets: page.map((row) => ticketView(row)),
    olderCursor:
      more && oldest ? encodeCursor('tickets', { time: oldest.cursorTime, id: oldest.id }) : null,
    unreadTotal: rows[0]?.unreadTotal ?? (await readUnreadTotal(caller)),
  };
}

// ---------------------------------------------------------------------------
// Marking read
// ---------------------------------------------------------------------------

export type ReadOutcome =
  | { kind: 'read'; ticket: TicketView; unreadTotal: number; marked: number }
  /** The ticket is not the caller's to read, for any reason, whatever `upTo` names. */
  | { kind: 'not_found' }
  /** `upTo` is not a message this API returns on this ticket. */
  | { kind: 'not_on_ticket' }
  /**
   * The session was no longer live once the marker held the account, or the
   * identity names no live contact any more (`holdAccount`).
   */
  | { kind: 'revoked' };

/**
 * Thrown inside the marker's transaction when the ticket is gone by the time
 * its answer is read, so the rows it marked roll back with it.
 */
class GoneAfterMarking extends Error {}

/**
 * The marker's write: the ticket's unread replies (`unreadReply`) at or before
 * `upTo` in the thread's own order, `(created_at, id)`, on a ticket the caller
 * may read — the id and `ownedTicket` in the statement that acts, as an
 * uncorrelated `EXISTS`, which runs once and locks no ticket.
 *
 * `read_at is null`, part of `unreadReply`, is the guard that makes marking
 * idempotent: marking twice, or backwards, matches no row, writes nothing and
 * fires no notification, and a marker that waited on another for a row
 * re-checks it and skips it, so `read_at` is never moved or unset.
 * `delivery_status` becomes `read` only from `sent` or `delivered`: a reply
 * stored as failed keeps its receipt in the console, which draws `failed` and
 * `bounced` as errors, rather than reading as delivered and read.
 *
 * Exported so a test can read the parameters it binds.
 */
export function markStatement(executor: Executor, caller: Caller, ticketId: string, upTo: Cursor) {
  return executor
    .update(messages)
    .set({
      readAt: sql`now()`,
      deliveryStatus: sql`case when ${messages.deliveryStatus} in ('sent', 'delivered')
        then 'read'::delivery_status else ${messages.deliveryStatus} end`,
    })
    .where(
      and(
        eq(messages.conversationId, ticketId),
        exists(
          db
            .select({ one: sql`1` })
            .from(conversations)
            .where(and(eq(conversations.id, ticketId), ownedTicket(caller))),
        ),
        unreadReply(),
        vsCursor('<=', upTo),
      ),
    )
    .returning({ id: messages.id });
}

/**
 * `POST /tickets/{id}/read`: marks the team's replies on one of the caller's
 * tickets read up to `upTo`, which the agent then sees as Read, and answers the
 * ticket and the new badge. One transaction, read and written on `tx`
 * throughout — a pooled read inside it is §6.91's self-deadlock:
 *
 * 1. **The account, then the requester, held** (`holdAccount`), as both sends
 *    hold them: a marker that comes after a revoke for the account, a sign-out
 *    included, finds its session no longer live and marks nothing; a contact
 *    merge committed since the gate is followed, and one not yet begun waits,
 *    so the marker never answers `404` for the user's own ticket — the answer
 *    the SDK meets by dropping the ticket and failing its outbox. Contact
 *    first, then the replies, the order a merge and a contact's purge lock in;
 *    the ticket's row is never locked.
 * 2. **One statement decides the answer**: the ticket, scoped, joined to
 *    `upTo` on it. No row is `404`: not the caller's, for any reason, which
 *    wins over anything `upTo` names, so asking about another user's ticket
 *    learns nothing from the `400`. A null `upToTime` is `400`: `upTo` is a
 *    note, a system row, a forward, a reaction, another ticket's message or
 *    nothing at all — anything the thread does not return (`kind = 'reply'`
 *    and `notReaction()`, in the query). It also reads `upTo`'s own timestamp
 *    text, the cursor's form, for the bound. A plain read: it locks nothing.
 * 3. **The write**, scoped again in its own `WHERE` (`markStatement`), so a
 *    ticket deleted, merged or marked spam since step 2 marks nothing.
 * 4. **The answer**, after the write and in the same transaction, so it sees
 *    it: a data-modifying CTE would read the snapshot from before the update.
 *    Each statement reads its own snapshot, so a spam mark, a delete or a
 *    merge committed between the write and this read leaves no ticket to
 *    answer: the transaction then rolls back (`GoneAfterMarking`) and answers
 *    `404`, so a request the app is told failed marks nothing the agent sees
 *    as Read.
 *
 * `created_at` is not commit order, so a reply stamped before `upTo` and
 * committed after the app's last poll is marked with it, a moment before the
 * app draws it. Accepted: the thread is ordered by `(created_at, id)`, the
 * app's next poll merges the reply into place before `upTo`
 * (`AFTER_OVERLAP_SECONDS`), and nothing is ever unmarked.
 */
export async function markTicketRead(
  caller: Caller,
  ticketId: string,
  upTo: string,
): Promise<ReadOutcome> {
  const now = new Date();
  try {
    return await db.transaction(async (tx) => {
      const holder = await holdAccount(tx, caller, now);
      if (!holder) return { kind: 'revoked' as const };

      // The message by its primary key, so the join is at most one row. A join
      // rather than a scalar subquery in the select list: drizzle writes a
      // one-table select's fields unqualified, and `conversation_id = id` there
      // compared the message with itself.
      const [found] = await tx
        .select({ upToTime: sql<string | null>`${messages.createdAt}::text` })
        .from(conversations)
        .leftJoin(
          messages,
          and(
            eq(messages.id, upTo),
            eq(messages.conversationId, conversations.id),
            eq(messages.kind, 'reply'),
            notReaction(),
          ),
        )
        .where(and(eq(conversations.id, ticketId), ownedTicket(holder)))
        .limit(1);
      if (!found) return { kind: 'not_found' as const };
      if (found.upToTime === null) return { kind: 'not_on_ticket' as const };

      const marked = await markStatement(tx, holder, ticketId, { time: found.upToTime, id: upTo });
      const after = await ownedTicketRow(holder, ticketId, { withTotal: true, executor: tx });
      if (!after) throw new GoneAfterMarking();
      return {
        kind: 'read' as const,
        ticket: ticketView(after),
        unreadTotal: after.unreadTotal,
        marked: marked.length,
      };
    });
  } catch (error) {
    if (error instanceof GoneAfterMarking) return { kind: 'not_found' };
    throw error;
  }
}

/**
 * `GET /attachments/{id}`: a short-lived link to one file's bytes, or null for
 * every reason the caller may not have it — not on one of their tickets, on a
 * note, a reaction or a ticket the team took out of the queue, inline in a body
 * this API never sends, or no file at all. One `404` from one statement, as a
 * ticket's is: the file is reached through its message and the message through
 * `readableMessage(caller)`, in the same `WHERE`, the predicate a thread
 * reads its messages through (`threadWhere`), so it is exactly the files a
 * thread lists (`messageFiles`) and no other. A file on a side
 * conversation hangs off no message and is never reached.
 *
 * The link is Storage's, signed for `ATTACHMENT_URL_TTL_SECONDS`, the console's
 * five minutes, and answered as JSON rather than a redirect, so no HTTP library
 * has to decide whether to forward the session's bearer to another host. It is
 * used at once and never logged or stored here; expiry is not revocation
 * (`lib/attachments/signed-url.ts` says why), so a `403` from Storage means ask
 * again.
 */
export async function attachmentLink(
  caller: Caller,
  attachmentId: string,
): Promise<z.input<typeof AttachmentLink> | null> {
  const [row] = await db
    .select({ path: attachments.storagePath })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.isInline, false),
        readableMessage(caller),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    url: await signedUrl(row.path, ATTACHMENT_URL_TTL_SECONDS),
    expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What the user sent, read and judged by the route (`sendFields`). */
export type Sent = {
  /**
   * Trimmed. Blank only beside files: neither is `400 empty_message` before
   * this, and a message of files alone is stored with their stand-in.
   */
  text: string;
  locale: 'ar' | 'en';
  /**
   * The `Idempotency-Key`, a UUID, as the client sent it, and found unspent on
   * the pool before the body was read (`keyAnswer`): the one way to come by
   * one, so a route cannot hand a writer a key nobody asked about.
   */
  key: UnspentKey;
  /** The request's `ShipBlu-Client`, which the gate has already parsed. */
  client: string;
  /** The files, in the order sent, each typed by its bytes; none for a JSON body. */
  uploads: readonly VisitorUpload[];
};

export type SendOutcome =
  | { kind: 'sent'; replayed: boolean; ticket: TicketView; message: MessageView }
  /** The ticket is not the caller's to read, or a replay's ticket no longer is. */
  | { kind: 'not_found' }
  /** The key was spent on another ticket, or on the other operation. */
  | { kind: 'key_reused' }
  /** `POST /tickets/{id}/messages` on a closed ticket. */
  | { kind: 'ticket_closed' }
  /** `POST /tickets` with no active `api` channel row. */
  | { kind: 'not_configured' }
  /** `POST /tickets` past `MAX_OPEN_TICKETS` open or pending. */
  | { kind: 'too_many_open' }
  /**
   * An unspent key past one of the identity's buckets: `POST /tickets`'s new
   * tickets, or either send's uploaded megabytes.
   */
  | { kind: 'rate_limited'; admission: Admission; bucket: 'new_tickets' | 'uploads' }
  /** A file could not be stored, so nothing was: the SDK sends again under the same key. */
  | { kind: 'upload_failed' }
  /**
   * A write whose session was no longer live once it held the account — revoked
   * or expired while it waited — or whose identity names no live contact any
   * more (`holdAccount`).
   */
  | { kind: 'revoked' };

type Keyed = { messageId: string; conversationId: string; operation: string | null };

declare const unspent: unique symbol;
/** An `Idempotency-Key` the pool found unspent: only `keyAnswer` makes one. */
export type UnspentKey = string & { readonly [unspent]: true };

/**
 * What a send's `Idempotency-Key` says before its body is read: the answer
 * when it is already spent — the replay, or `key_reused` — or the key, marked
 * unspent for the writer.
 *
 * Asked by both routes on the pool before `sendFields`, so a retry is answered
 * without its body being parsed, copied and sniffed: the SDK's outbox resends
 * a send it never heard back from on every foreground, a 25 MB video
 * included, and each retry held some 50 MB on the web service for an answer
 * that used none of it. Before the budgets as well, so a retry is never
 * refused by them. Only ever a shortcut: each writer reads the key again under
 * the account's lock, which decides between two retries racing, and the
 * unique index behind that is the backstop.
 */
export async function keyAnswer(
  caller: Caller,
  key: string,
  operation: Operation,
  ticketId?: string,
): Promise<{ answer: SendOutcome } | { key: UnspentKey }> {
  const keyed = await findKeyed(db, caller, key);
  if (keyed) return { answer: await replay(caller, keyed, operation, ticketId) };
  return { key: key as UnspentKey };
}

/**
 * The message an `Idempotency-Key` was already spent on, if any. The key is
 * namespaced by the caller's identity (`keyOf`), so this finds only the
 * caller's own; the ticket it names is then read through `ownedTicket`.
 */
async function findKeyed(executor: Executor, caller: Caller, key: string): Promise<Keyed | null> {
  const [row] = await executor
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      operation: sql<string | null>`${messages.meta}->>'apiOperation'`,
    })
    .from(messages)
    .where(eq(messages.channelMessageId, keyOf(caller, key)))
    .limit(1);
  return row ?? null;
}

/**
 * The answer to a key already spent: what the first request stored, read as it
 * stands through `ownedTicket`, with `Idempotent-Replayed`. A key spent on the
 * other operation, or on another ticket, is `409 key_reused`, and nothing is
 * written. A ticket the user can no longer read — deleted, marked spam or merged
 * away since — is `404 not_found`, and nothing is created: the key is spent on
 * the stored message, and a second ticket is what the key exists to prevent.
 *
 * `ticketId` is compared with the row's id in code, so it is the lower-case
 * spelling Postgres prints: the route canonicalises the path's
 * (`canonicalUuid`), or a retry on `0B6F…` met `0b6f…` here as another ticket.
 */
async function replay(
  caller: Caller,
  keyed: Keyed,
  operation: Operation,
  ticketId?: string,
): Promise<SendOutcome> {
  if (keyed.operation !== operation) return { kind: 'key_reused' };
  if (ticketId !== undefined && keyed.conversationId !== ticketId) return { kind: 'key_reused' };
  // Under the contact the identity names now, never the gate's: a key is spent
  // twice exactly when two requests race, which is when a merge can have moved
  // the contact the first one filed its message under, and the gate's then
  // answered `404` for a ticket holding the user's message, which the SDK
  // read as gone and dropped.
  const holder = await requesterNow(caller);
  if (!holder) return { kind: 'revoked' };
  return answerSent(holder, keyed.conversationId, keyed.messageId, true);
}

async function answerSent(
  caller: Caller,
  ticketId: string,
  messageId: string,
  replayed: boolean,
): Promise<SendOutcome> {
  const ticket = await readTicket(caller, ticketId);
  const message = ticket ? await readMessage(caller, ticketId, messageId) : null;
  return ticket && message ? { kind: 'sent', replayed, ticket, message } : { kind: 'not_found' };
}

/** A failed insert answered by the unique index on the key, and the first request's message. */
async function keyedAfterConflict(
  error: unknown,
  caller: Caller,
  key: string,
): Promise<Keyed | null> {
  if (!isUniqueViolation(error, 'messages_channel_message_idx')) return null;
  return findKeyed(db, caller, key);
}

/** What `messages.meta` holds for a message from the app. */
function metaFor(sent: Sent, operation: Operation): Record<string, unknown> {
  return {
    // The app's language, which `requesterLocale` reads when no message on the
    // ticket has words in it — a photo sent with no caption (stage 7).
    locale: sent.locale,
    // What `426` is decided on, kept as the build that wrote the message.
    client: sent.client,
    apiOperation: operation,
    // What was sent, under the widget's key and through the widget's own
    // function, for the stand-in's rebuild (`isMediaStandIn`): the console's
    // thread leaves the stand-in out where the files are drawn, and this API
    // answers its `text` as `""`.
    ...webchatFilesMeta(sent.uploads),
  };
}

/**
 * What a message is stored as saying: the user's words, or for files sent
 * with none, the stand-in every chat's media gets (`webchatFilesStandIn`), so
 * the subject, the inbox card and search have something to read. The threads
 * and this API leave it out (`standsIn`); `subjectWords` reads the subject it
 * makes as null.
 */
/** The bytes a send's files weigh, which the upload budget is counted in (`uploadFits`). */
function uploadedBytes(sent: Sent): number {
  return sent.uploads.reduce((sum, upload) => sum + upload.bytes.length, 0);
}

function storedText(sent: Sent): string {
  return sent.text || webchatFilesStandIn(sent.uploads);
}

/**
 * The upload budget's refusal for this send, or null: asked before anything is
 * stored and spent only once the message is (`spendUpload`), so a send whose
 * files failed costs nothing to retry (`uploadFits` in `lib/api/limits.ts`).
 */
function uploadAdmission(caller: Caller, sent: Sent): SendOutcome | null {
  if (sent.uploads.length === 0) return null;
  const admission = uploadFits(caller.identityId, uploadedBytes(sent));
  return admission.allowed ? null : { kind: 'rate_limited', admission, bucket: 'uploads' };
}

/**
 * The message's files in Storage, under the ticket it is for and the id the
 * message will be written with, before the transaction that writes it — the
 * widget's order (`appendVisitorMessage`), for the widget's reason: the user is
 * still there, so a file that cannot be stored refuses the send and nothing is
 * kept, where a message stored without its photo would leave an agent reading
 * about a picture that is not there. `storeVisitorFiles` is the widget's own,
 * so the keys, the deadline and the clean-up after a failure are one code path
 * for every customer's upload. Null when a file could not be stored, with
 * everything tried removed.
 */
async function storeFiles(
  conversationId: string,
  messageId: string,
  uploads: readonly VisitorUpload[],
): Promise<StoredUpload[] | null> {
  if (uploads.length === 0) return [];
  try {
    return await storeVisitorFiles(conversationId, messageId, uploads);
  } catch (error) {
    if (error instanceof VisitorUploadFailed) return null;
    throw error;
  }
}

/**
 * The files' rows, in the message's own transaction, so the live update that
 * tells the console about the message finds its files, and a message is never
 * stored without them: the widget's rows (`attachmentRows`), a millisecond
 * apart in the order sent.
 */
async function insertFiles(
  tx: Executor,
  messageId: string,
  stored: readonly StoredUpload[],
  now: Date,
): Promise<void> {
  if (stored.length === 0) return;
  await tx.insert(attachments).values(attachmentRows(messageId, stored, now));
}

/**
 * Files stored ahead of a message whose transaction answered a refusal — every
 * refusal is answered before the message's insert, so nothing references them
 * — removed without asking whether the message exists.
 */
async function discardFiles(stored: readonly StoredUpload[], conversationId: string) {
  await discardPaths(
    stored.map((file) => file.path),
    conversationId,
  );
}

/**
 * Whether a write whose transaction threw, other than on the key's unique
 * index, committed after all: a COMMIT sent and its answer lost with the
 * connection (`db/client.ts`). Its message is then looked for by the id it was
 * given, as the widget looks for one (`releaseUnlessStored`): found, the write
 * stood, its files are kept, and the caller carries on as though the
 * transaction had answered, so the work after a commit — the on-create rules,
 * the first SLA selection, routing, assignment, the out-of-hours reply, the
 * upload budget — runs. Answered `500`, as it was, none of it ran in the
 * request, and the SDK's retry under the same key is a replay, which runs
 * none of it either: only the backstop a minute on did (`lib/api/finish.ts`),
 * and the upload budget went unspent. Not
 * found, its files are removed and the error stands; an answer that could not
 * be read keeps them, and the error stands too.
 *
 * With or without files, since the work after the commit is owed either way.
 */
async function committedAfterAll(
  error: unknown,
  stored: readonly StoredUpload[],
  messageId: string,
  conversationId: string,
): Promise<boolean> {
  const outcome = await releaseUnlessStored(
    messageId,
    stored.map((file) => file.path),
    conversationId,
  );
  if (outcome !== 'stored') return false;
  log.warn(
    `a transaction answered with an error but its message was stored, carried on message_id=${messageId}`,
    scrubbed(error),
  );
  return true;
}

/**
 * The contact the identity names now, for a write that committed with its
 * answer lost (`committedAfterAll`): a merge can have moved it since the gate
 * read it, as it can for a replay. The gate's own when the identity names none,
 * and when the read fails: the pool has just lost one answer, a second read on
 * it can fail too, and thrown here its error took the place of the first —
 * the request answered `500` with an unrelated stack, and the upload budget
 * the stored files owed went unspent, since the SDK's retry is a replay.
 */
async function requesterAfterLostAnswer(caller: Caller): Promise<Caller> {
  try {
    return (await requesterNow(caller)) ?? caller;
  } catch (error) {
    log.warn(
      `could not read the requester again after a lost answer, carried on with the session's identity=${caller.identityId}`,
      scrubbed(error),
    );
    return caller;
  }
}

/**
 * `opened_from_app`'s payload: which app, platform and versions opened the
 * ticket, and through which identity. Read off the request's `ShipBlu-Client`
 * — `sdk-ts/0.3.0 app/5.4.1 ios/18.1`, the SDK first — which is the build that
 * is asking now, and off the session's mint where the header does not name the
 * platform or the app: labels for an agent to read, never a credential. The
 * SDK is stored as its name and its version apart (`sdk-ts`, `0.3.0`), so a
 * reader comparing versions has a version to compare. A token with no `/` is
 * passed over rather than split: the gate refuses one today, and split, it
 * would be keyed on all but its last character.
 */
function provenance(caller: Caller, client: string) {
  const tokens = client.split(' ').flatMap((token) => {
    const slash = token.indexOf('/');
    return slash > 0 ? [[token.slice(0, slash), token.slice(slash + 1)] as const] : [];
  });
  const named = new Map(tokens);
  const [sdk] = tokens;
  const platform = named.has('ios') ? 'ios' : named.has('android') ? 'android' : caller.platform;
  return {
    app: 'myblu',
    platform,
    appVersion: named.get('app') ?? caller.appVersion,
    sdk: sdk?.[0] ?? null,
    sdkVersion: sdk?.[1] ?? null,
    identityId: caller.identityId,
  };
}

/** Open or pending tickets the caller has now, read on the transaction behind the account lock. */
async function openTickets(tx: Executor, caller: Caller): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(ownedTicket(caller), inArray(ticketStatuses.category, ['open', 'pending'])));
  return row?.count ?? 0;
}

/**
 * `POST /tickets`: open a ticket on the `api` channel with its first message.
 *
 * Shaped like an ingest path, and not a parameter on `createTicket`, the forms'
 * function, in this order:
 *
 * 1. **The pool's reads, cheapest refusal first**, after the key, which the
 *    route asked before it read the body (`keyAnswer`): the channel row
 *    (`not_configured`), the open tickets (`too_many_open`, asked
 *    again under the lock), the upload budget and the new-ticket bucket
 *    (`rate_limited`), then `planRouting`. The refusals no wait can change come
 *    before the budgets, so a create the app cannot make is told so at once
 *    rather than after an hour's `Retry-After`.
 * 2. **The files to Storage** (`storeFiles`), which can take seconds over
 *    mobile data and hold up to 25 MB, before anything is written: a file that
 *    cannot be stored refuses the send and nothing is kept.
 * 3. **The session judged** (`asked`), after the upload.
 * 4. **One transaction** that takes one `now` once it holds the account and
 *    the requester — so the message is stamped when it was stored, not when its
 *    upload began nor before a lock's wait — and writes the ticket with the
 *    routing window spread into its insert, the message and its files' rows,
 *    the ownership row, the work owed after it (`oweFinish`), the
 *    `opened_from_app` event and `startRouting`, and reads nothing on the pool
 *    (AGENTS.md, _postgres.js must never pipeline…_). A refusal under its lock
 *    removes the files; a transaction that threw but committed, its answer
 *    lost, carries on as stored (`committedAfterAll`).
 * 5. **After the commit**, the upload budget is spent and the request takes
 *    the work it owes and runs it (`finishInRequest`): the claimed tracking
 *    number's link, then the on-create rules, the first SLA selection,
 *    `beginRouting`, assignment and the out-of-hours reply in the order every
 *    other path runs them. A request that ends before it leaves the work to
 *    the worker, a minute on, rather than to a retry that is answered as a
 *    replay (`lib/api/finish.ts`).
 *
 * The new-ticket bucket is charged only for a ticket opened. Asked on the pool
 * once the key is known to be unspent (`newTicketFits`, which spends nothing),
 * so a create past it is refused before a file is stored or a lock taken;
 * spent in the transaction once it has decided to insert, under the account
 * lock, so one account's creates spend it one at a time. A replay never
 * spends it — spent by replays, the bucket refused the eleventh retry of one
 * ticket `429`, and the user's next real ticket with it, for an hour — and
 * nor does a create refused `not_configured`, `too_many_open` or for a revoked
 * session, which an outbox resends on every foreground. A transaction that
 * spends and then rolls back on the key's unique index, a create racing
 * another under one key, is the one way a token goes on nothing opened.
 *
 * The transaction takes the caller's account lock first (`holdAccount`), so a
 * create and a revoke for one account are ordered, and one account's creates
 * one after another: under it the key is read again — a create racing this one
 * under the same key has committed, and this one is its replay, never a refusal
 * for the ticket that first one opened — and then the open tickets are counted,
 * so ten is ten. The unique index on the key is the backstop, and a `23505`
 * rolls this transaction back, its `settle_routing` and `finish_api_message`
 * keys with it, and answers what the first request stored.
 *
 * Everything the transaction writes is filed under the contact `holdAccount`
 * read through the identity and holds, never the one the gate read: a contact
 * merge committed in between would otherwise leave the new ticket on the
 * folded contact, answered `201` and never readable again (`holdRequester`).
 *
 * `requester_kind` is left null, as on every channel: `requesterKindFrom()`
 * writes it from the contact's records where it is null, so a value stamped
 * here would hold a merchant who also uses myBlu at `recipient` for good. And
 * no assignee: assignment is the creation pass's, through the one writer of
 * the column (`lib/tickets/assignee.ts`).
 */
export async function createApiTicket(
  caller: Caller,
  sent: Sent & { trackingNumber: string | null },
): Promise<SendOutcome> {
  // The refusals no wait can change, before the budgets: a create at the cap
  // or with the app's row off is told so at once, not `429` with up to an
  // hour to wait first. The open count is asked on the pool too, before the
  // files go to Storage — a 25 MB video uploaded only to be removed, on every
  // foreground an outbox resends it — and only ever refuses: the count under
  // the account lock decides.
  const channel = await apiChannel();
  if (!channel) return { kind: 'not_configured' };
  if ((await openTickets(db, caller)) >= MAX_OPEN_TICKETS) return { kind: 'too_many_open' };

  const upload = uploadAdmission(caller, sent);
  if (upload) return upload;
  const ahead = newTicketFits(caller.identityId);
  if (!ahead.allowed) return { kind: 'rate_limited', admission: ahead, bucket: 'new_tickets' };

  // Before the transaction, which must read nothing on the pool (`lib/routing/start.ts`).
  const routing = await planRouting(channel);

  const conversationId = randomUUID();
  const messageId = randomUUID();
  const stored = await storeFiles(conversationId, messageId, sent.uploads);
  if (!stored) return { kind: 'upload_failed' };
  // After the files, which can take seconds: the session is judged when the
  // upload is done, and the rows are stamped later still, once the transaction
  // holds what it waits on — when the message was stored, not when its upload
  // began (`appendVisitorMessage`).
  const asked = new Date();
  const text = storedText(sent);

  let written:
    | { kind: 'created'; as: Caller; now: Date }
    | { kind: 'revoked' | 'too_many_open' }
    | { kind: 'rate_limited'; admission: Admission; bucket: 'new_tickets' }
    | { kind: 'spent'; keyed: Keyed };
  try {
    written = await db.transaction(async (tx) => {
      const holder = await holdAccount(tx, caller, asked);
      if (!holder) return { kind: 'revoked' as const };
      const first = await findKeyed(tx, holder, sent.key);
      if (first) return { kind: 'spent' as const, keyed: first };
      if ((await openTickets(tx, holder)) >= MAX_OPEN_TICKETS) {
        return { kind: 'too_many_open' as const };
      }
      // Decided: spent here, and refused only by a create that spent the last
      // token between the pool's question and this lock.
      const admission = admitNewTicket(holder.identityId);
      if (!admission.allowed)
        return { kind: 'rate_limited' as const, admission, bucket: 'new_tickets' as const };
      // Once the account and the requester are held, so the ticket's and the
      // message's instants are not older than their commit by a lock's wait
      // (`AFTER_OVERLAP_SECONDS`); the routing window counts from it too.
      const now = new Date();

      const statusId = await requireDefaultOpenStatusId(tx);
      await tx.insert(conversations).values({
        id: conversationId,
        channel: 'api',
        channelId: channel.id,
        statusId,
        // An app ticket has no subject line: the opening words, as a chat's,
        // or its files' stand-in, which `subjectWords` answers as null.
        subject: preview(text, 80) || UNNAMED_SUBJECT.api,
        requesterContactId: holder.contactId,
        groupId: channel.defaultGroupId,
        createdAt: now,
        lastMessageAt: now,
        lastCustomerMessageAt: now,
        // Held for the router from the insert (`lib/routing/start.ts`).
        ...routingWindowValues(routing, {}, now),
      });

      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: holder.contactId,
        bodyText: text,
        channelMessageId: keyOf(holder, sent.key),
        deliveryStatus: 'delivered',
        deliveredAt: now,
        meta: metaFor(sent, 'createTicket'),
        createdAt: now,
      });
      await insertFiles(tx, messageId, stored, now);

      await tx.insert(apiTickets).values({
        conversationId,
        identityId: holder.identityId,
        trackingNumber: sent.trackingNumber,
        createdAt: now,
      });
      // The work after the commit, owed whatever becomes of this request.
      await oweFinish(tx, { messageId, conversationId, now });

      // In the creating transaction, so the on-create rules and the ticket's
      // header see it from the first moment.
      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'opened_from_app',
        actorLabel: 'myblu',
        data: provenance(holder, sent.client),
      });

      await startRouting(
        tx,
        routing,
        { conversationId, messageId, groupId: channel.defaultGroupId },
        now,
      );
      return { kind: 'created' as const, as: holder, now };
    });
  } catch (error) {
    const first = await keyedAfterConflict(error, caller, sent.key);
    if (first) {
      // The key's index refused the insert, so this transaction rolled back.
      await discardFiles(stored, conversationId);
      return replay(caller, first, 'createTicket');
    }
    if (!(await committedAfterAll(error, stored, messageId, conversationId))) throw error;
    // Its holder and its `now` went with the lost answer. The contact is read
    // through the identity again, as a replay reads it; a create's clocks count
    // from the ticket's own `created_at`, so `asked` stands in for the rest.
    written = { kind: 'created', as: await requesterAfterLostAnswer(caller), now: asked };
  }

  if (written.kind !== 'created') await discardFiles(stored, conversationId);
  if (written.kind === 'spent') return replay(caller, written.keyed, 'createTicket');
  if (written.kind === 'rate_limited') return written;
  if (written.kind !== 'created') return { kind: written.kind };
  const { as: holder, now } = written;
  if (sent.uploads.length > 0) spendUpload(caller.identityId, uploadedBytes(sent));

  await finishInRequest({
    conversationId,
    messageId,
    bodyText: text,
    created: true,
    at: now,
    trackingNumber: sent.trackingNumber,
  });
  return answerSent(holder, conversationId, messageId, false);
}

/**
 * The ticket's "last" columns after a message from the user: moved forward only
 * (`latest()`), as every ingest path moves them, and bound as text behind
 * `::timestamptz`. Exported so a test can read its parameters back.
 */
export function customerWrote(now: Date) {
  return {
    lastMessageAt: latest(conversations.lastMessageAt, now),
    lastCustomerMessageAt: latest(conversations.lastCustomerMessageAt, now),
  };
}

/**
 * The status of a ticket this identity opened, read on the pool before a
 * send's files are stored, or null for one it did not open, or that is on
 * another channel, deleted, spam or merged away.
 *
 * Only ever a refusal, never a grant: the send's own locked read is
 * `ownedTicket` in full, and decides. So it asks `ownedTicketNow`, the same
 * predicate with the requester read through the identity in this statement
 * rather than off the gate's contact, which a contact merge committed since
 * would have moved: it refuses what the locked read refuses — a ticket whose
 * requester an agent moved is `404` here too, not its status — and never what
 * it would accept.
 */
async function openedStatus(
  caller: Caller,
  ticketId: string,
): Promise<TicketView['status'] | null> {
  const [row] = await db
    .select({ status: ticketStatuses.category })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(eq(conversations.id, ticketId), ownedTicketNow(caller)))
    .limit(1);
  return row?.status ?? null;
}

/**
 * `POST /tickets/{id}/messages`: the user's reply on one of their tickets.
 *
 * The ticket is locked by the statement that finds it, `ownedTicket` in its
 * `WHERE`: the ownership row is joined on columns nothing changes, and every
 * other half is the locked row's own, so a writer it waited on cannot make it
 * answer no row for a ticket that is there (AGENTS.md, _A read that locks a
 * row…_). The status is read the way every locked read reads it
 * (`statusCategoryOf`). `FOR NO KEY UPDATE`, taken before any write, so a
 * message inserted on the ticket meanwhile is not held up by it.
 *
 * Before the ticket, the caller's account lock and the requester
 * (`holdAccount`), as a create takes them. The lock orders the reply against
 * a revoke: without it, a revoke for `account_deleted` or `number_released`
 * committing between the gate and this transaction deleted the ownership rows
 * a statement already under way could still read, and a deleted account, or a
 * number's previous holder, wrote to the team — reopening a resolved ticket —
 * and was then answered `404` for a message stored. Under it, a reply that
 * comes first commits before the revoke reads, and one that comes after finds
 * its session no longer live and writes nothing (`revoked`), whatever ended
 * it, a sign-out included. The requester is the contact the identity names
 * now, held, which the ticket is looked for under and the message authored
 * as: a contact merge moves the ticket's requester, so the gate's contact,
 * after a merge committed since, answered `404` for the user's own ticket; and
 * locking the ticket first waited on a merge that was waiting for it, since
 * the message's author is the contact the merge has locked. It also puts one
 * account's replies one after another, which costs a user nothing a person
 * typing can notice.
 *
 * The open cap is not counted here: it bounds the tickets a user opens, and a
 * reply reopening one they already have is that ticket going on, not a new
 * one (`maxOpen`, `GET /config`).
 *
 * A send with files asks first, on the pool, whether the ticket is one this
 * identity opened and is not closed (`openedStatus`, which only refuses), then
 * the upload budget, then stores the files and takes its `now` after them, as
 * a create does: a closed ticket is `409` at once rather than after the
 * budget's hour, and nothing goes to Storage for a send the ticket refuses. A
 * refusal under the lock removes the files; a transaction that threw but
 * committed carries on as stored (`committedAfterAll`).
 *
 * A reply to a `resolved` ticket reopens it through `reopenResolved`, as every
 * customer's reopen does; one to a `closed` ticket is refused, and the app
 * offers a new ticket. Two retries racing under one key wait on the account's
 * lock in turn, and the second finds the first's message behind it and is its
 * replay; the unique index on the key is the backstop.
 */
export async function sendApiMessage(
  caller: Caller,
  ticketId: string,
  sent: Sent,
): Promise<SendOutcome> {
  const messageId = randomUUID();
  let files: StoredUpload[] = [];
  if (sent.uploads.length > 0) {
    // No upload onto a ticket the user cannot write on: a closed ticket, or
    // an id that is not theirs, refused before 25 MB go to Storage only to be
    // removed again. The locked read below still decides. Before the upload
    // budget, so a send to a closed ticket is told `409` at once and offered a
    // new ticket, not `429` with up to an hour to wait for that answer.
    const status = await openedStatus(caller, ticketId);
    if (status === null) return { kind: 'not_found' };
    if (status === 'closed') return { kind: 'ticket_closed' };
    const upload = uploadAdmission(caller, sent);
    if (upload) return upload;
    const stored = await storeFiles(ticketId, messageId, sent.uploads);
    if (!stored) return { kind: 'upload_failed' };
    files = stored;
  }
  // After the files, which can take seconds: stamped before them, a message
  // could land behind an agent's reply written during its upload, and no
  // reply clock would start (`appendVisitorMessage` says the same). The
  // session is judged now; the rows are stamped once the transaction holds the
  // account, the requester and the ticket.
  const asked = new Date();
  const text = storedText(sent);

  let stored:
    | { kind: 'stored'; as: Caller; now: Date }
    | { kind: 'spent'; keyed: Keyed }
    | { kind: 'not_found' | 'ticket_closed' | 'revoked' };
  try {
    stored = await db.transaction(async (tx) => {
      const holder = await holdAccount(tx, caller, asked);
      if (!holder) return { kind: 'revoked' as const };
      // Read again behind the account's lock, as a create reads it: two
      // retries of one send wait on it in turn, and the second is the first's
      // replay here rather than a write that meets the unique index.
      const first = await findKeyed(tx, holder, sent.key);
      if (first) return { kind: 'spent' as const, keyed: first };

      const [ticket] = await tx
        .select({
          id: conversations.id,
          statusId: conversations.statusId,
          statusCategory: statusCategoryOf(),
          reopenCount: conversations.reopenCount,
        })
        .from(conversations)
        .where(and(eq(conversations.id, ticketId), ownedTicket(holder)))
        .for('no key update', { of: conversations });
      if (!ticket) return { kind: 'not_found' as const };
      // After the last lock this waits on — the account's, a merge's on the
      // contact, the ticket's — so the message's `created_at` precedes its
      // commit by this transaction's own statements, never by a wait: stamped
      // before them, a reply that waited out a merge committed older than
      // `AFTER_OVERLAP_SECONDS`, behind a cursor another device's poll had
      // already moved past, and no poll returned it.
      const now = new Date();

      const category = await lockedStatusCategory(tx, ticket);
      if (category === 'closed') return { kind: 'ticket_closed' as const };
      if (category === 'resolved') {
        await reopenResolved(
          tx,
          { id: ticket.id, reopenCount: ticket.reopenCount },
          { actorLabel: 'myblu', reason: 'customer_replied' },
        );
      }

      await tx.insert(messages).values({
        id: messageId,
        conversationId: ticketId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: holder.contactId,
        bodyText: text,
        channelMessageId: keyOf(holder, sent.key),
        deliveryStatus: 'delivered',
        deliveredAt: now,
        meta: metaFor(sent, 'sendMessage'),
        createdAt: now,
      });
      await insertFiles(tx, messageId, files, now);

      await tx.update(conversations).set(customerWrote(now)).where(eq(conversations.id, ticketId));
      await oweFinish(tx, { messageId, conversationId: ticketId, now });
      return { kind: 'stored' as const, as: holder, now };
    });
  } catch (error) {
    const first = await keyedAfterConflict(error, caller, sent.key);
    if (first) {
      // The key's index refused the insert, so this transaction rolled back.
      await discardFiles(files, ticketId);
      return replay(caller, first, 'sendMessage', ticketId);
    }
    if (!(await committedAfterAll(error, files, messageId, ticketId))) throw error;
    // As a create's: the contact read again, and `asked` for the stamp that
    // went with the answer. The reply clock counts from the newer of it and
    // `last_customer_message_at`, which the commit moved to that stamp.
    stored = { kind: 'stored', as: await requesterAfterLostAnswer(caller), now: asked };
  }

  if (stored.kind !== 'stored') {
    await discardFiles(files, ticketId);
    if (stored.kind === 'spent') return replay(caller, stored.keyed, 'sendMessage', ticketId);
    return { kind: stored.kind };
  }
  if (sent.uploads.length > 0) spendUpload(caller.identityId, uploadedBytes(sent));

  await finishInRequest({
    conversationId: ticketId,
    messageId,
    bodyText: text,
    created: false,
    at: stored.now,
    trackingNumber: null,
  });

  return answerSent(stored.as, ticketId, messageId, false);
}
