import type { z } from 'zod';
import { isUuid } from '@/lib/http/uuid';
import type { VisitorUpload } from '@/lib/widget/conversation';
import { MAX_WIDGET_REQUEST_BYTES } from '@/lib/widget/files';
import { readVisitorUploads } from '@/lib/widget/uploads';
import { decodeCursor } from './cursor';
import { invalidBody, invalidRequest, jsonBody, rateLimited } from './errors';
import { apiError, apiJson } from './respond';
import {
  CreateTicketMultipart,
  CreateTicketRequest,
  ListMessagesQuery,
  ListTicketsQuery,
  MarkReadRequest,
  SendMessageMultipart,
  SendMessageRequest,
  type ReadResult,
  type SendResult,
} from './schemas';
import type { ListAsked, PageAsked, ReadOutcome, SendOutcome } from './tickets';

/**
 * What the ticket routes read off a request and how they answer a write, each
 * written once: the two message-writing routes share every step but the call
 * in the middle, and a step spelled twice is a refusal that drifts.
 */

/**
 * The `Idempotency-Key`: a UUID, as `isUuid` reads one. Missing and not a UUID
 * are one answer, `400 idempotency_key_required`, rather than the second an
 * `invalid_request` would make: either way the request carries nothing the
 * server can promise a replay on, and the SDK's one handling of it — its own
 * bug, never retried — is right for both.
 */
export function idempotencyKey(
  request: Request,
  requestId: string,
): { key: string } | { refusal: Response } {
  const key = request.headers.get('idempotency-key');
  if (isUuid(key)) return { key };
  return {
    refusal: apiError(
      'idempotency_key_required',
      key === null
        ? 'Idempotency-Key is required on a request that writes a message.'
        : 'Idempotency-Key must be a UUID.',
      { requestId },
    ),
  };
}

/** What a send carries, read off its body: the fields, and its files read and judged. */
export type SendFields = {
  /** Trimmed. Blank only when there are files: neither is `400 empty_message`. */
  text: string;
  locale: 'ar' | 'en';
  /** Only `POST /tickets` takes one; absent on `POST /tickets/{id}/messages`. */
  trackingNumber?: string;
  /** In the order sent, each typed by its bytes; empty for a JSON body. */
  uploads: VisitorUpload[];
};

/** The two requests that write a message, by the schemas each encoding is read with. */
const SEND_SCHEMAS = {
  createTicket: { json: CreateTicketRequest, multipart: CreateTicketMultipart },
  sendMessage: { json: SendMessageRequest, multipart: SendMessageMultipart },
} as const;

const EMPTY = 'A message needs words or files.';

/**
 * A write's body, in either encoding the contract publishes, read with the
 * operation's own schemas and judged as the widget judges a message
 * (`plans/myblu-ticket-api.md`, _Files_), or the refusal. Never cut short:
 * text over the limit is the schema's `invalid_request`.
 *
 * - **JSON** carries `text`, required, and no files: blank once trimmed is
 *   `empty_message`.
 * - **Multipart** carries the same fields as parts and `files` repeated, one
 *   part per file in the order to show them, and `text` may then be blank.
 *   `Content-Length` is required (`411 length_required`) and read before the
 *   body: the proxy clones a body under `proxyClientMaxBodySize` and truncates
 *   one past it rather than refusing it, so a body with no length, or one
 *   longer than the widget's own ceiling (`MAX_WIDGET_REQUEST_BYTES`,
 *   `413 too_large`), would arrive cut short with nothing to say so. Stricter
 *   than the widget, which reads a body with no length: an SDK builds its body
 *   in a file, and knows its length before it sends a byte.
 * - **Files** are judged by the widget's own functions (`readVisitorUploads`):
 *   the count, the size of each and of all of them, the label each carries —
 *   or, with none or `application/octet-stream`, its filename's extension —
 *   and then the bytes, which decide the type stored. A refusal is
 *   `file_refused` naming the reason, and the file where the refusal is about
 *   one. A `files` part that is not a file — one sent with no filename, which
 *   `formData()` reads as text — is `invalid_request` naming `files`.
 *
 * Parts the operation does not take are ignored, as a JSON field it does not
 * know is. Nothing is stored here: the bytes are held for the write, which
 * stores them with the message or not at all (`lib/api/tickets.ts`).
 */
/**
 * A multipart text part with its line breaks put back as they were typed.
 * The HTML encoding of a form turns each line break in a text value into
 * CRLF, and browsers and undici's `FormData` follow it, so the words sent with
 * a photo arrived longer than the same words sent as JSON — a message of 1,900
 * characters and 150 line breaks was refused as too long beside a photo and
 * taken without one — and were stored with CRs the JSON path never has. Before
 * the schema, so the limit counts what the user wrote. A file part is left as
 * it is.
 */
function unixLines(part: FormDataEntryValue | undefined): FormDataEntryValue | undefined {
  return typeof part === 'string' ? part.replace(/\r\n?/g, '\n') : part;
}

export async function sendFields(
  request: Request,
  requestId: string,
  operation: keyof typeof SEND_SCHEMAS,
): Promise<SendFields | { refusal: Response }> {
  const schemas = SEND_SCHEMAS[operation];
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type.trim())) {
    const parsed = schemas.json.safeParse(await jsonBody(request));
    if (!parsed.success) return { refusal: invalidBody(requestId, parsed.error) };
    const text = parsed.data.text.trim();
    if (text === '') return { refusal: apiError('empty_message', EMPTY, { requestId }) };
    return { ...parsed.data, text, uploads: [] };
  }

  const length = request.headers.get('content-length')?.trim() ?? '';
  if (!/^\d+$/.test(length)) {
    return {
      refusal: apiError('length_required', 'A multipart body must carry Content-Length.', {
        requestId,
      }),
    };
  }
  if (Number(length) > MAX_WIDGET_REQUEST_BYTES) {
    return {
      refusal: apiError(
        'too_large',
        `The body is longer than ${MAX_WIDGET_REQUEST_BYTES} bytes; GET /config gives the limits on files.`,
        { requestId },
      ),
    };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { refusal: invalidRequest(requestId, 'The multipart body could not be read.') };
  }

  const parsed = schemas.multipart.safeParse({
    text: unixLines(form.get('text') ?? undefined),
    locale: form.get('locale') ?? undefined,
    trackingNumber: form.get('trackingNumber') ?? undefined,
    files: form.getAll('files'),
  });
  if (!parsed.success) {
    // A part's own index is no field the request spelled: `files` is.
    if (parsed.error.issues[0]?.path[0] === 'files') {
      return {
        refusal: invalidRequest(
          requestId,
          'files: every files part must be a file, with a filename.',
          'files',
        ),
      };
    }
    return { refusal: invalidBody(requestId, parsed.error) };
  }

  const { files = [], text: written, ...fields } = parsed.data;
  const text = (written ?? '').trim();
  if (text === '' && files.length === 0) {
    return { refusal: apiError('empty_message', EMPTY, { requestId }) };
  }

  const read = await readVisitorUploads(files);
  if (!read.ok) {
    const { refusal } = read;
    return {
      refusal: apiError('file_refused', `A file was refused: ${refusal.reason}.`, {
        requestId,
        reason: refusal.reason,
        filename: 'filename' in refusal ? refusal.filename : null,
      }),
    };
  }
  return { ...fields, text, uploads: read.uploads };
}

/**
 * Which page of a thread a request asks for, read with the schema's own rules
 * — a page of 1 to 100, 30 when not given, and never both cursors — or the
 * refusal. A cursor that is not one this server minted for a thread, by its
 * shape or by its signature — the tickets list's included — is
 * `400 invalid_cursor`, never a first page. Both cursors at once is
 * `invalid_request` naming no field, as the schema's refinement decides
 * (neither is wrong alone), and its sentence speaks of the query, which is
 * where both arrived.
 */
export function pageAsked(url: URL, requestId: string): PageAsked | { refusal: Response } {
  const params = url.searchParams;
  const parsed = ListMessagesQuery.safeParse({
    after: params.get('after') ?? undefined,
    before: params.get('before') ?? undefined,
    limit: params.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      refusal:
        field === 'after' || field === 'before'
          ? invalidCursor(requestId)
          : invalidBody(requestId, parsed.error, 'The query'),
    };
  }

  const { after, before, limit } = parsed.data;
  const text = after ?? before;
  if (text === undefined) return { kind: 'newest', limit };
  const cursor = decodeCursor('messages', text);
  if (!cursor) return { refusal: invalidCursor(requestId) };
  return after !== undefined
    ? { kind: 'after', cursor, text, limit }
    : { kind: 'before', cursor, text, limit };
}

/**
 * Which page of the list a request asks for, read with the schema's own rules —
 * a page of 1 to 100, 30 when not given, a tracking number of 1 to 64 of
 * `A-Z a-z 0-9 -` — or the refusal. `pageAsked`'s twin: a cursor this server
 * did not mint for the list is `400 invalid_cursor`, never a first page — a
 * thread's included, which signs under a purpose of its own (`CursorKind`) —
 * and anything else the schema refuses is `invalid_request` naming the
 * parameter, in zod's words, which name the pattern and never the value, so a
 * refused tracking number is not written into the app's log; a refusal that
 * names no parameter speaks of the query, as `pageAsked`'s does. Parameters the
 * list does not take — `after`, a status — are ignored, as a field the server
 * does not know is.
 */
export function listAsked(url: URL, requestId: string): ListAsked | { refusal: Response } {
  const params = url.searchParams;
  const parsed = ListTicketsQuery.safeParse({
    before: params.get('before') ?? undefined,
    limit: params.get('limit') ?? undefined,
    trackingNumber: params.get('trackingNumber') ?? undefined,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      refusal:
        field === 'before'
          ? invalidCursor(requestId)
          : invalidBody(requestId, parsed.error, 'The query'),
    };
  }

  const { before, limit, trackingNumber } = parsed.data;
  if (before === undefined) return { cursor: null, limit, trackingNumber: trackingNumber ?? null };
  const cursor = decodeCursor('tickets', before);
  if (!cursor) return { refusal: invalidCursor(requestId) };
  return { cursor, limit, trackingNumber: trackingNumber ?? null };
}

function invalidCursor(requestId: string): Response {
  return apiError('invalid_cursor', 'The cursor was not minted by this server.', { requestId });
}

/** The `404` every route answers for a ticket that is not the caller's, for whatever reason. */
export function ticketNotFound(requestId: string): Response {
  return apiError('not_found', 'No ticket of this user has that id.', { requestId });
}

/** The `404` for a file that is not on one of the caller's tickets, for whatever reason. */
export function attachmentNotFound(requestId: string): Response {
  return apiError('not_found', 'No file on a ticket of this user has that id.', { requestId });
}

/**
 * The read marker's body, `{ upTo }`, or `400 invalid_request` naming `upTo`
 * (or nothing, for a body that is not a JSON object — unparseable, an array, a
 * string, `null` — whose zod issue has no path) before any query: a malformed id
 * would reach Postgres as 22P02, a `500`. `upTo` is lower-cased, the one
 * spelling every id this API answers is in, as a path's id is. An unknown key
 * is dropped, as on every request. No `Idempotency-Key`: marking is
 * idempotent by its rule.
 */
export async function markBody(
  request: Request,
  requestId: string,
): Promise<{ upTo: string } | { refusal: Response }> {
  const parsed = MarkReadRequest.safeParse(await jsonBody(request));
  if (!parsed.success) return { refusal: invalidBody(requestId, parsed.error) };
  return { upTo: parsed.data.upTo.toLowerCase() };
}

/**
 * The answer to a write whose session was ended while it waited, or whose
 * identity names no live contact any more: `401`, which the SDK meets with one
 * refresh and one replay. One sentence for every write that holds the account
 * or the requester.
 */
function sessionEndedWhileWaiting(requestId: string): Response {
  return apiError(
    'unauthenticated',
    'This session was ended while the request waited; ask for a new one.',
    { requestId },
  );
}

/** The read marker's outcome, answered (`markTicketRead`). */
export function answerRead(outcome: ReadOutcome, requestId: string): Response {
  switch (outcome.kind) {
    case 'read': {
      const body: z.input<typeof ReadResult> = {
        ticket: outcome.ticket,
        unreadTotal: outcome.unreadTotal,
      };
      return apiJson(body, { requestId });
    }
    case 'not_found':
      return ticketNotFound(requestId);
    case 'not_on_ticket':
      return invalidRequest(
        requestId,
        'upTo is not a message this API returned on this ticket.',
        'upTo',
      );
    case 'revoked':
      return sessionEndedWhileWaiting(requestId);
  }
}

/**
 * A write's outcome, answered: `201` the first time, `200` with
 * `Idempotent-Replayed: true` for a key already spent on this request, and
 * each refusal under the status its code is answered with.
 */
export function answerSend(outcome: SendOutcome, requestId: string): Response {
  switch (outcome.kind) {
    case 'sent': {
      const body: z.input<typeof SendResult> = {
        ticket: outcome.ticket,
        message: outcome.message,
      };
      return outcome.replayed
        ? apiJson(body, { requestId, headers: { 'Idempotent-Replayed': 'true' } })
        : apiJson(body, { requestId, status: 201 });
    }
    case 'not_found':
      return ticketNotFound(requestId);
    case 'key_reused':
      return apiError(
        'key_reused',
        'This Idempotency-Key was sent with another ticket or another operation.',
        { requestId },
      );
    case 'ticket_closed':
      return apiError('ticket_closed', 'The ticket is closed; open a new one.', { requestId });
    case 'not_configured':
      return apiError('not_configured', 'Opening tickets is switched off here.', { requestId });
    case 'too_many_open':
      return apiError(
        'too_many_open',
        'This user has as many open tickets as one user may have at once.',
        { requestId },
      );
    case 'rate_limited':
      return rateLimited(
        requestId,
        outcome.admission,
        outcome.bucket === 'uploads'
          ? 'Too many megabytes of files from this user this hour'
          : 'Too many new tickets from this user',
      );
    case 'upload_failed':
      return apiError(
        'upload_failed',
        'A file could not be stored, so nothing was: send again under the same Idempotency-Key.',
        { requestId },
      );
    case 'revoked':
      return sessionEndedWhileWaiting(requestId);
  }
}
