/**
 * How a Freshdesk URL reaches `app/help/legacy/route.ts`, the one place that
 * resolves it to an article here.
 *
 * Pure and import-free, because `proxy.ts` imports it and the proxy stays out of
 * the database (its header says why).
 *
 * **In a request header, not a query string.** The proxy used to rewrite to
 * `/help/legacy?path=<the Freshdesk path>`, and the route read `?path=`. Next 16
 * hands a route handler the request as it arrived: after a proxy rewrite,
 * `request.url` is still `/support/solutions/articles/<id>`, so the `path` the
 * rewrite added is in no URL the handler can read. Every legacy shape answered
 * the route's own 404 through the proxy while the same route called directly
 * answered 301 (`docs/PROJECT-STATE.md` §6.115). A header set on the rewrite's
 * request (`NextResponse.rewrite(url, { request: { headers } })`) is how a proxy
 * passes a value to what it rewrites to, and it arrives.
 *
 * Anybody can send the header to `/help/legacy` themselves, and that is no more
 * than calling the route with `?path=`, which stays supported for exactly that:
 * the route only ever answers a redirect to a public article URL, or a 404.
 */

/** The header the proxy puts the requested Freshdesk path in. */
export const LEGACY_PATH_HEADER = 'x-legacy-path';

/**
 * The Freshdesk path a request to the legacy route asks about: the proxy's
 * header, or `?path=` on a direct call, or empty.
 */
export function legacyPathOf(request: Request): string {
  return (
    request.headers.get(LEGACY_PATH_HEADER) ?? new URL(request.url).searchParams.get('path') ?? ''
  );
}
