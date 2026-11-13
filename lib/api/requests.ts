import type { z } from 'zod';
import { isUuid } from '@/lib/http/uuid';
import { decodeCursor } from './cursor';
import { invalidBody, invalidRequest, jsonBody, rateLimited } from './errors';
import { apiError, apiJson } from './respond';
import { ListMessagesQuery, type SendResult } from './schemas';
import type { PageAsked, SendOutcome } from './tickets';

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

/**
 * Files arrive with the files stage (stage 7). Before it a multipart body is
 * `400 invalid_request`, naming the header, so an SDK built for files meets a
 * refusal that says what this server does not take rather than a body it
 * could not read.
 */
export function refuseMultipart(request: Request, requestId: string): Response | null {
  const type = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\b/i.test(type.trim())) return null;
  return invalidRequest(
    requestId,
    'This server takes a message as JSON; files are not accepted here yet.',
    'Content-Type',
  );
}

/**
 * A write's JSON body, parsed with its schema, its text trimmed and judged:
 * `invalid_request` naming the field for a body its schema refuses, and
 * `empty_message` for text that is blank once trimmed — neither words nor, in
 * JSON, files. Never cut short: text over the limit is the schema's refusal.
 */
export async function sendBody<T extends { text: string }>(
  request: Request,
  requestId: string,
  schema: z.ZodType<T>,
): Promise<{ body: T } | { refusal: Response }> {
  const parsed = schema.safeParse(await jsonBody(request));
  if (!parsed.success) return { refusal: invalidBody(requestId, parsed.error) };
  const text = parsed.data.text.trim();
  if (text === '') {
    return {
      refusal: apiError('empty_message', 'A message needs words or files.', { requestId }),
    };
  }
  return { body: { ...parsed.data, text } };
}

/**
 * Which page of a thread a request asks for, read with the schema's own rules
 * — a page of 1 to 100, 30 when not given, and never both cursors — or the
 * refusal. A cursor that is not one this server minted, by its shape or by its
 * signature, is `400 invalid_cursor`, never a first page. Both cursors at once
 * is `invalid_request` naming no field, as the schema's refinement decides
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
  const cursor = decodeCursor(text);
  if (!cursor) return { refusal: invalidCursor(requestId) };
  return after !== undefined
    ? { kind: 'after', cursor, text, limit }
    : { kind: 'before', cursor, text, limit };
}

function invalidCursor(requestId: string): Response {
  return apiError('invalid_cursor', 'The cursor was not minted by this server.', { requestId });
}

/** The `404` every route answers for a ticket that is not the caller's, for whatever reason. */
export function ticketNotFound(requestId: string): Response {
  return apiError('not_found', 'No ticket of this user has that id.', { requestId });
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
      return rateLimited(requestId, outcome.admission, 'Too many new tickets from this user');
    case 'revoked':
      return apiError(
        'unauthenticated',
        'This session was ended while the request waited; ask for a new one.',
        { requestId },
      );
  }
}
