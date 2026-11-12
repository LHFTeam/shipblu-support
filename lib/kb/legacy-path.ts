import { isLocale } from './locale';

/**
 * How a Freshdesk URL reaches `app/help/legacy/route.ts`, the one place that
 * resolves it to an article or a category here.
 *
 * Pure, importing only `./locale`, which imports nothing, because `proxy.ts`
 * imports it and the proxy stays out of the database (its header says why).
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
 * the route only ever answers a redirect to a public article or category page
 * or the help centre's home, or a 404.
 */

/** The header the proxy puts the requested Freshdesk path in. */
export const LEGACY_PATH_HEADER = 'x-legacy-path';

/**
 * The language a Freshdesk portal URL can start with: two letters in any case,
 * optionally with a region (`/ar`, `/EN`, `/en-US`), captured as `language`.
 * A regex source rather than a pattern, so every reader of a Freshdesk path a
 * request names is built from it: the category's shape below, `portalLanguage`,
 * and the portal's own pages (`./freshdesk-portal.ts`). Written once, the
 * proxy, the legacy route and the portal's rules cannot read a different
 * language out of one URL. A link inside an article body is read by
 * `rewriteLegacyArticleLinks` (`./format.ts`), with a pattern of its own that
 * finds the URL in markup. It reads `/EN/` as no language of ours and falls
 * back to the linking article's own, where the route reads it as English.
 *
 * Whether the two letters name a language of ours stays each reader's own
 * question, because they ask it for different reasons. The portal's rules and
 * `freshdeskCategoryId` decide whether a path is Freshdesk's at all, and refuse
 * one whose language is not ours: `/kb/support/…` is the console's.
 * `portalLanguage` reads a preference out of a path already known to be
 * Freshdesk's, and the choice falls back past a language we lack.
 */
export const FRESHDESK_LANGUAGE = String.raw`/(?<language>[A-Za-z]{2})(?:-[A-Za-z]{2})?`;

/** Freshdesk's category URL; `freshdeskCategoryId` says why each part is there. */
const FRESHDESK_CATEGORY = new RegExp(
  String.raw`^(?:${FRESHDESK_LANGUAGE})?/support/solutions/(?<id>\d+)(?:-[^/]*)?/?$`,
);

const LEADING_LANGUAGE = new RegExp(String.raw`^${FRESHDESK_LANGUAGE}/`);

/**
 * The language a Freshdesk portal URL names (`/en/support/…`,
 * `/EN-us/support/…`), in lower case, or undefined. Not checked against
 * `LOCALES`: a language the help centre lacks matches no translation, and the
 * choice goes on to the default.
 */
export function portalLanguage(path: string): string | undefined {
  return LEADING_LANGUAGE.exec(path)?.groups?.language?.toLowerCase();
}

/**
 * The id in a Freshdesk category URL, `/support/solutions/154000297679`, with
 * one of our languages in front or not (`/ar`, `/EN`, `/en-US`) and the
 * category's title after the id or not (`-shipblu-partners`), or null.
 *
 * `proxy.ts` hands the legacy route exactly the paths this reads an id from, by
 * asking it, so the proxy cannot send the route a path the route reads no id
 * from. It reads exactly the paths `./freshdesk-portal.ts` read as a category
 * before the legacy route could find one's page, so moving them changed the
 * answer for no other path:
 *
 *  - An article's or a folder's URL is this shape with one more segment,
 *    `articles` or `folders`, which `\d+` cannot read.
 *  - The `/support/` it asks for keeps every help-centre path out, since none
 *    has that segment.
 *  - A language, where there is one, must be ours, as the portal's rules
 *    require. Any other two letters are no ShipBlu portal's, and a console
 *    route of two letters with `support` beneath it (`/kb/support/…`) is ours.
 *    Such a path is left to the rest of the proxy.
 *  - It is anchored at both ends, where the article's and the folder's patterns
 *    are not. The start keeps out a Freshdesk tail behind another prefix
 *    (`/ar/en/support/…`, or `/help/ar/support/…` on the Render host). The end
 *    keeps out a page of a category's list (`/support/solutions/<id>/page/2`).
 *    The article and folder patterns are unanchored on purpose, to read every
 *    prefix an account could be configured with (`proxy.ts`), and anchoring
 *    them would change PR 3's answers, which is a change of its own.
 *  - A trailing slash is read alike, as the portal's rules read one: Next
 *    answers it with a 308 before the proxy runs, so one rarely arrives.
 */
export function freshdeskCategoryId(path: string): string | null {
  const match = FRESHDESK_CATEGORY.exec(path);
  const language = match?.groups?.language?.toLowerCase();
  if (language !== undefined && !isLocale(language)) return null;
  return match?.groups?.id ?? null;
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
