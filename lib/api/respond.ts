import { randomUUID } from 'node:crypto';
import {
  ERROR_STATUS,
  type ErrorBody,
  type ErrorCode,
  type FileRefusalReason,
} from '@/lib/api/schemas';
import type { z } from 'zod';

/**
 * How every `/api/v1` route answers, success or refusal, so none spells it out
 * again.
 *
 * Two headers ride on every answer, which is the whole reason this is one
 * module rather than `NextResponse.json` at each call site:
 *
 * - **`ShipBlu-Request-Id`**, repeated in an error's body, so an app
 *   developer's bug report names a log line rather than a time and a guess.
 * - **`Cache-Control: no-store`.** Every answer is one user's tickets, or the
 *   refusal of a request for them; a cache between the app and this server —
 *   a carrier's proxy, an HTTP library's own — holding one would hand it to
 *   the next request for the same URL, and on a shared device that can be
 *   somebody else.
 *
 * And one shape for every refusal, `{ error: { code, message, requestId } }`,
 * where the widget's routes answer five: an SDK branches on `code`, and on the
 * status `ERROR_STATUS` gives it for a code it does not know.
 */

const JSON_TYPE = 'application/json; charset=utf-8';

/** A fresh id for one request. Opaque to the client, which only quotes it. */
export function newRequestId(): string {
  return randomUUID();
}

type AnswerInit = {
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
};

function headersFor(init: AnswerInit): Headers {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('ShipBlu-Request-Id', init.requestId);
  return headers;
}

/** A successful answer: `body` as JSON, with the two headers every answer carries. */
export function apiJson(body: unknown, init: AnswerInit): Response {
  return apiJsonText(JSON.stringify(body), init);
}

/**
 * The same answer for a body already serialised, which the caller vouches is
 * JSON: the contract's route, whose 120 kilobytes are the same on every
 * request and are stringified once (`openApiDocumentJson`). One function under
 * both, so a body sent as text cannot leave without the two headers.
 */
export function apiJsonText(json: string, init: AnswerInit): Response {
  const headers = headersFor(init);
  headers.set('Content-Type', JSON_TYPE);
  return new Response(json, { status: init.status ?? 200, headers });
}

/**
 * `204 No Content`: the two headers, and no body and no `Content-Type`, since
 * there is nothing for one to describe.
 */
export function apiNoContent(init: Omit<AnswerInit, 'status'>): Response {
  return new Response(null, { status: 204, headers: headersFor(init) });
}

type ErrorExtras = {
  requestId: string;
  /** On `invalid_request`, the one field to blame, as the request spelled it. */
  field?: string;
  /** On `file_refused`. */
  reason?: z.output<typeof FileRefusalReason>;
  /** On `file_refused`: the file refused, or null when it is all of them. */
  filename?: string | null;
};

/**
 * On `rate_limited`, and only there: sent as `Retry-After`, the seconds the
 * limiter says are left. Required, because a `429` without it leaves an SDK to
 * guess a wait — the guide's scenario 6 obeys the header, and the document
 * publishes it on every `429` — and refused on any other code, where the
 * document publishes no `Retry-After` for a client to read.
 */
type RateLimitedExtras = ErrorExtras & { retryAfterSeconds: number };
type OtherExtras = ErrorExtras & { retryAfterSeconds?: never };

/**
 * A refusal. The status comes from the code, never from the caller, so a code
 * cannot be answered under two statuses by two routes — a client that meets a
 * code it does not know falls back on the status, and the two must agree.
 *
 * `message` is English for a developer's log and is never shown to the user,
 * so it may say exactly what was wrong; it must never carry a token, a phone or
 * the body that was refused, since the app may log it.
 *
 * Two overloads, so `rate_limited` without `retryAfterSeconds` does not
 * compile. A caller holding an `ErrorCode` it has not narrowed matches neither
 * and must narrow it first, which is the point: such a code can be
 * `rate_limited`.
 */
export function apiError(
  code: 'rate_limited',
  message: string,
  extras: RateLimitedExtras,
): Response;
export function apiError(
  code: Exclude<ErrorCode, 'rate_limited'>,
  message: string,
  extras: OtherExtras,
): Response;
export function apiError(
  code: ErrorCode,
  message: string,
  extras: RateLimitedExtras | OtherExtras,
): Response {
  const body: ErrorBody = {
    error: {
      code,
      message,
      requestId: extras.requestId,
      ...(extras.field !== undefined && { field: extras.field }),
      ...(extras.reason !== undefined && { reason: extras.reason }),
      ...(extras.filename !== undefined && { filename: extras.filename }),
    },
  };

  const headers: Record<string, string> = {};
  if (extras.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(extras.retryAfterSeconds)));
  }

  return apiJson(body, { requestId: extras.requestId, status: ERROR_STATUS[code], headers });
}
