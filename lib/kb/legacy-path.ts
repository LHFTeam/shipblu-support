/**
 * How a Freshdesk URL reaches `app/help/legacy/route.ts`, the one place that
 * resolves it to an article, a folder or a category here.
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
 * the route only ever answers a redirect to a public article, folder or
 * category page, or to a `kb_redirects` row's own path, or a 404.
 */

/** The header the proxy puts the requested Freshdesk path in. */
export const LEGACY_PATH_HEADER = 'x-legacy-path';

/**
 * Freshdesk's category URL, which `proxy.ts` hands to the legacy route as its
 * `LEGACY_CATEGORY` and `freshdeskCategoryId` reads the id out of: one pattern,
 * so the proxy cannot send a path the route reads no id from. Its comment says
 * why each part is there.
 */
export const FRESHDESK_CATEGORY =
  /^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/support\/solutions\/(\d+)(?:-[^/]*)?\/?$/;

/**
 * The id in a Freshdesk category URL, `/support/solutions/154000297679`, with
 * the portal's language in front or not (`/ar`, `/en-US`) and the category's
 * title after the id or not (`-shipblu-partners`), or null.
 *
 * The pattern is `FRESHDESK_CATEGORY`, the one the proxy sends by. An article's
 * or a folder's URL is this shape with one more segment, `articles` or
 * `folders`, which `\d+` cannot read. The `/support/` it asks for keeps every
 * help-centre path out, since none has that segment. And it is anchored at
 * both ends, where the article's and the folder's patterns are not: the start
 * so that a Freshdesk tail behind another prefix (`/ar/en/support/…`, or
 * `/help/ar/support/…` on the Render host) is not read as Freshdesk's, and the
 * end so that a page of a category's list (`/support/solutions/<id>/page/2`)
 * is not read as the category. A trailing slash is read alike, as
 * `lib/kb/freshdesk-portal.ts` reads one: Next answers it with a 308 before
 * the proxy runs, so one rarely arrives.
 */
export function freshdeskCategoryId(path: string): string | null {
  return FRESHDESK_CATEGORY.exec(path)?.[1] ?? null;
}

/**
 * Freshdesk's folder URL, which `proxy.ts` hands to the legacy route as its
 * `LEGACY_FOLDER` and `freshdeskFolderId` reads the id out of: one pattern, as
 * the category's is, so the proxy cannot send a path the route reads no id
 * from.
 */
export const FRESHDESK_FOLDER = /\/solutions\/folders\/(\d+)/;

/**
 * The id in a Freshdesk folder URL, `/support/solutions/folders/154000746959`,
 * in every prefix an article's URL takes (`/support`, `/a`, none, a portal
 * language in front), or null.
 *
 * Anchored at neither end, unlike the category's pattern, because the folder
 * shape has always been read this way and the log shows each variant followed:
 * `/solutions/folders/<id>` and `/<locale>/support/…` by crawlers since the
 * domain moved. `folders` is a segment no help-centre path has, so nothing of
 * ours is read as one.
 *
 * **A page of a folder's list reads as the folder.** Freshdesk split a folder's
 * articles over pages, `/folders/<id>/page/2`, and the log shows pages 1 and 2
 * of `154000746959` (15 articles) followed since the move, under `/ar` and
 * `/en`, by crawlers and a headless browser. The help centre's folder page
 * lists every article in one page (`getFolder` takes no limit), so whatever a
 * page of Freshdesk's listed is on it, and that page is the answer for any of
 * them, as it is for the folder: a 404 would turn away a reader whose answer is
 * one page away, and a page of its own here would be the same list cut short.
 * Freshdesk's `?url_locale=` beside it is a query, which the proxy does not
 * pass; the path's own language is read instead.
 */
export function freshdeskFolderId(path: string): string | null {
  return FRESHDESK_FOLDER.exec(path)?.[1] ?? null;
}

/**
 * The Freshdesk path a request to the legacy route asks about: the proxy's
 * header, or `?path=` on a direct call, or empty.
 *
 * The direct call has a different address on each host, because the help
 * centre's own host puts `/help` in front of every path it is asked for:
 * `/help/legacy?path=…` on the service URL, and `/legacy?path=…` on
 * `KB_PUBLIC_HOST`, where `/help/legacy` would become `/help/help/legacy` and
 * answer the page 404. Its `?path=` still arrives there, because the client
 * sent it and the proxy's rewrite only moves the path.
 */
export function legacyPathOf(request: Request): string {
  // `||`, so a header sent empty falls through to `?path=` rather than hiding it.
  return (
    request.headers.get(LEGACY_PATH_HEADER) || new URL(request.url).searchParams.get('path') || ''
  );
}
