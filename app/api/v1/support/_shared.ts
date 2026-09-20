import { apiError } from '@/lib/myblu/errors';
import { resolveSession, type MobileSession } from '@/lib/myblu/session';

/**
 * The three things every route under `/api/v1/support` needs, in one place.
 *
 * A leaf file rather than a `lib/` module because all of it is about the shape
 * of an HTTP request; nothing here would mean anything to a job or a page.
 */

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
 * Resolve the support session, or the response to return instead.
 *
 * A **403**, never a 401. myBlu's HTTP client calls `logout()` on any
 * authenticated 401 and clears the customer's whole session — so a support
 * token going stale would sign somebody out of the app for not having opened
 * support in a week. 403 says "re-handshake", which the app can do silently
 * with the platform bearer it still holds.
 *
 * Returning the response rather than throwing keeps every route's happy path a
 * straight line, and means a route cannot accidentally proceed on a null
 * session: there is no shape here that gives you both.
 */
export async function authorise(request: Request): Promise<Authorised> {
  const token = bearerFrom(request);
  const session = token ? await resolveSession(token) : null;

  if (!session) return { error: apiError(request, 'support_session_expired') };
  return { session };
}
