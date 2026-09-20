import { hashToken } from '@/lib/auth/tokens';
import { allow } from '@/lib/kb/rate-limit';
import { apiError } from '@/lib/myblu/errors';
import { resolveSession, type MobileSession } from '@/lib/myblu/session';

/**
 * What every route under `/api/v1/support` needs, in one place.
 *
 * A leaf file rather than a `lib/` module because all of it is about the shape
 * of an HTTP request; none of it would mean anything to a job or a page.
 */

/** The longest message body accepted, on every write path. */
export const MAX_BODY = 5_000;

/** The bearer, or empty. Case-insensitive, because clients differ. */
export function bearerFrom(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/** The locale tag the app asked for, kept as it sent it. */
export function localeOf(request: Request): string | null {
  const header = request.headers.get('accept-language');
  return header ? header.split(',')[0]!.trim().slice(0, 12) : null;
}

export type Authorised = { session: MobileSession } | { error: Response };

/**
 * Rate limit, then resolve the support session — in that order.
 *
 * The order is the point. Resolving first means a client spending ten times its
 * budget still costs a `mobile_sessions` read per request, so the limiter would
 * protect nothing but the work *after* it; the 429s would be free for the
 * caller and not for us.
 *
 * Bucketed on the token rather than the client address: Egyptian mobile
 * carriers NAT hard enough that a per-IP bucket is one bucket for a whole
 * network, where a single busy customer locks everybody else out. The token is
 * also the thing being spent.
 *
 * Returning the response rather than throwing keeps each route's happy path a
 * straight line, and means a route cannot proceed on a null session by
 * accident: there is no shape here that hands back both.
 */
export async function authorise(
  request: Request,
  bucket: string,
  perMinute: number,
): Promise<Authorised> {
  const token = bearerFrom(request);
  if (!token) return { error: apiError(request, 'support_session_expired') };

  if (!allow(`myblu-${bucket}:${hashToken(token)}`, perMinute, 60_000)) {
    return { error: apiError(request, 'rate_limited') };
  }

  const session = await resolveSession(token);

  // A **403**, never a 401. myBlu's HTTP client calls `logout()` on any
  // authenticated 401 and clears the customer's whole session — so a support
  // token going stale would sign somebody out of the app for not having opened
  // support in a week. 403 says "re-handshake", which the app can do silently
  // with the platform bearer it still holds.
  if (!session) return { error: apiError(request, 'support_session_expired') };
  return { session };
}

/**
 * Run a handler, turning anything it throws into a body the app can read.
 *
 * Without this, a transient database error or a throw out of
 * `upsertShipmentStub` becomes Next's own 500 — which carries no `code` and no
 * `message`, so `extractErrorMessage` finds nothing and shows the customer
 * `Error code: 500`. That is the precise outcome `lib/myblu/errors.ts` exists
 * to prevent, and it would have been the one thing the error module could not
 * cover, because it was never reached.
 */
export async function handle(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error(`[myblu] ${request.method} ${new URL(request.url).pathname} failed`, error);
    return apiError(request, 'server_error');
  }
}
