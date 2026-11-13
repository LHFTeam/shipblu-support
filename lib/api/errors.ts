import type { z } from 'zod';
import type { Admission } from '@/lib/http/rate-limit';
import { logger } from '@/lib/log';
import { apiError } from './respond';

/**
 * The refusals more than one `/api/v1` route answers, each written once, and
 * the one way a route turns a failure into `500 internal`.
 *
 * `apiError` (`respond.ts`) is the shape; this is the wording. A refusal's
 * `message` is English for a developer's log, which the app may write down, so
 * none of these repeats what the request carried: never a token, a phone, an
 * `externalUserId` or a body.
 */

const log = logger('api');

export function notConfigured(requestId: string): Response {
  return apiError('not_configured', 'The API is not switched on here.', { requestId });
}

export function rateLimited(requestId: string, admission: Admission, what: string): Response {
  return apiError('rate_limited', `${what}; wait for Retry-After.`, {
    requestId,
    retryAfterSeconds: admission.resetInSeconds,
  });
}

export function invalidRequest(requestId: string, message: string, field?: string): Response {
  return apiError('invalid_request', message, { requestId, ...(field && { field }) });
}

/**
 * A body its schema refused: `invalid_request`, with `field` naming the first
 * field to blame as the request spelled it (`client.platform`), or none when
 * the body itself is the wrong shape. zod's own sentence says what was wrong
 * and never what was sent — it does not repeat the input unless asked to — so
 * a refused phone is not written into the app's log.
 */
export function invalidBody(requestId: string, error: z.ZodError): Response {
  const issue = error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.join('.') : undefined;
  const message = issue
    ? `${field ?? 'The body'}: ${issue.message}`
    : 'The body does not match the request schema.';
  return invalidRequest(requestId, message, field);
}

/**
 * The request's JSON, or `undefined` when it is not JSON. Read whatever the
 * `Content-Type` says, since a backend that forgot the header has still sent
 * JSON, and what matters is whether it parses.
 */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

const FAILED = 'Something failed on the server. The request id names it in the log.';

/**
 * Runs a route's work, and answers `500 internal` for whatever it throws, with
 * one log line naming the route and the request id — the id the answer
 * carries, so an app developer's bug report finds the line.
 *
 * The line carries a scrubbed copy of the failure, never the failure itself.
 * drizzle wraps every query that fails as "Failed query: <sql> params: <…>",
 * and Postgres puts the offending values in `detail` ("Key (identifier)=
 * (myblu:…) already exists"): logged whole, a failed mint would write the
 * phone and the `externalUserId` into Render's log, which an `/api/v1` line
 * never carries (AGENTS.md, _Logging_).
 */
export async function answering(
  route: string,
  requestId: string,
  work: () => Promise<Response>,
): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    log.error(`failed route=${route} requestId=${requestId}`, scrubbed(error));
    return apiError('internal', FAILED, { requestId });
  }
}

/**
 * The failure's kind, its SQLSTATE when it has one, the first line of the
 * underlying message and the stack frames: what a reader needs to find the
 * fault, and none of the query, its parameters or Postgres's `detail`.
 */
function scrubbed(error: unknown): Error {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const name = cause instanceof Error ? cause.name : typeof cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? ` ${cause.code}`
      : '';
  const message = cause instanceof Error ? (cause.message.split('\n')[0] ?? '') : '';

  const out = new Error(`${name}${code}: ${message}`);
  const frames =
    error instanceof Error
      ? (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line))
      : [];
  out.stack = [`Error: ${out.message}`, ...frames].join('\n');
  return out;
}
