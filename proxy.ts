import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie';
import { freshdeskPortalRedirect } from '@/lib/kb/freshdesk-portal';
import { FRESHDESK_FOLDER, freshdeskCategoryId, LEGACY_PATH_HEADER } from '@/lib/kb/legacy-path';
import { LOCALES } from '@/lib/kb/locale';

/**
 * Two jobs, both of which have to happen before anything touches a database.
 *
 * 1. Host routing. One Next app serves two surfaces: the agent console and the
 *    public help centre. Requests arriving on the help-centre hostname are
 *    rewritten under `/help`, so support.shipblu.com/en/a/foo renders
 *    /help/en/a/foo while the URL the customer sees stays clean.
 *
 * 2. The signed-out redirect for the console. This only checks that a session
 *    cookie exists — it cannot tell a revoked session from a live one.
 *    `requireAgent()` does that on the page itself. The value here is that a
 *    signed-out visitor lands on /login instead of watching a console shell
 *    render and bounce.
 *
 * Staying out of the database is a choice, not a limit of the runtime. Next 16
 * runs the proxy on Node.js (a proxy file may not even declare a `runtime`), so
 * a query here would work. It would also sit in front of every request the app
 * serves but static assets — each prefetch, poll and widget call — to repeat a
 * check the page makes anyway.
 *
 * Nothing here protects a server action from a forged cross-site request
 * either — no line looks at a POST's origin. Two things outside this file do:
 *
 *  - Next refuses an action whose `Origin` host differs from the host the
 *    request arrived on (`X-Forwarded-Host` when a proxy sets it, else
 *    `Host`). `next.config.ts` sets no `serverActions.allowedOrigins`, so no
 *    other origin is admitted. A request with no `Origin` is let through with
 *    a warning: every current browser sends one with a POST, and a client that
 *    leaves it off is not carrying an agent's cookie.
 *  - The session cookie is host-only and `SameSite=Lax` (`lib/auth/session.ts`),
 *    so a browser leaves it off a POST from another site. Site, not origin: a
 *    page on another subdomain of the same registrable domain is the same site,
 *    its POSTs carry the cookie, and only Next's check is left to refuse them.
 *    So wherever the console is served under shipblu.com, it is one site with
 *    every other shipblu.com subdomain. That includes support.shipblu.com
 *    whenever `KB_PUBLIC_HOST` does not name it, as on 2026-11-12, the day
 *    after that name moved here, and any shipblu.com domain the console moves
 *    to later.
 *
 * Both ask where a request came from, never what made it, so neither can tell
 * the console from anything else answered on the console's origin: script
 * running there is same-origin to the one and same-site to the other, and can
 * call every action with the agent's cookie. The help centre is served here
 * already — `/help`, and the locale paths rewritten to it below, on every
 * host — and that is safe because it is this app's own rendering, with every
 * body an attacker can supply sanitised on write. A rewrite that puts a page whose script we do not
 * write on this origin — Freshdesk's pages proxied through, an attachment
 * served inline instead of redirected to its signed URL, a third-party status
 * page — gives that page every action the console has. It needs a host of its
 * own.
 */

/** Paths that are public on every hostname. */
const PUBLIC_PREFIXES = [
  '/help',
  '/login',
  '/setup',
  '/invite',
  '/api/webhooks',
  '/api/health',
  // The page `/api/health` renders to prove that rendering works, fetched over
  // the loopback with no session. Left to the cookie check below it would
  // answer 307 to /login, whose HTML is a perfectly good 200. The page refuses
  // any request without the health check's token, so being public here
  // exposes nothing (`lib/health/probe.ts`).
  '/probe',
  '/api/auth',
  '/api/kb',
  // The widget page and every endpoint it calls. Both halves are needed: the
  // iframe loads /widget, then fetches /api/widget/* with no session cookie,
  // and a missing entry here turns each of those calls into a redirect to
  // /login that the widget cannot follow.
  '/api/widget',
  '/widget',
  '/_next',
];

/**
 * The files a page's `<head>` names, at the root: Next serves each from a file
 * in `app/`, and `app/icon.svg` is the `<link rel="icon">` on every page the
 * root layout renders, the help centre's included. Most of what fetches one
 * carries no session: a signed-out reader's browser drawing a tab, a crawler, a
 * link preview. So they are served as themselves on every hostname, signed in or
 * not. Under the cookie check `/icon.svg` answered 307 to /login on every host,
 * so no signed-out reader saw the icon (measured 2026-11-12). On the help-centre
 * host the catch-all would rewrite it to `/help/icon.svg`, where nothing answers.
 *
 * The suffixes are the ones Next's own matcher allows (`isMetadataRouteFile`):
 * a numbered variant (`icon1.png`), the hash a file in a route group is served
 * under (`/icon-1u176d.svg`), and no extension for an image drawn by code
 * (`app/icon.tsx` is `/icon`). One that draws several, through
 * `generateImageMetadata`, is served once per id beneath that (`/icon/small`).
 * `proxy.test.ts` finds every such file in `app/` through Next's functions, so
 * a file this pattern misses fails there.
 * `robots.txt` and `sitemap.xml` are metadata files too, and they are the help
 * centre's (`CRAWLER_FILES`).
 */
const HEAD_FILE =
  /^\/(?:favicon\.ico|manifest\.(?:webmanifest|json)|(?:icon|apple-icon|opengraph-image|twitter-image)\d?(?:-\w{6})?(?:\.(?:ico|jpe?g|png|svg|gif)|\/[^/]+)?)$/;

/**
 * Freshdesk article URLs, in every prefix variant an account can be configured
 * with (`/support/solutions/...`, `/a/solutions/...`, bare `/solutions/...`).
 * Matching on the article id rather than the whole path is what makes one rule
 * cover all of them — the trailing title text changes whenever someone edits
 * the title, so it was never a reliable key.
 */
const LEGACY_ARTICLE = /\/solutions\/articles\/(\d+)/;

/**
 * `/en`, `/ar`, and anything beneath them: one alternative per entry in
 * LOCALES, so a locale added there reaches the help centre without a second
 * edit here. The hand-written version said it was kept in step with LOCALES,
 * and only that note did the keeping. A locale code is two lowercase letters,
 * so joining them needs no escaping.
 */
const LOCALE_PREFIX = new RegExp(`^/(${LOCALES.join('|')})(/|$)`);

/**
 * Freshdesk's folder page, `/support/solutions/folders/<id>`, in the same
 * prefix variants as an article's, and a page of its list (`/<id>/page/2`),
 * which reads as the folder. Its page here is `/<locale>/c/<category>/<folder>`,
 * found by a lookup (`resolveLegacyPath`). The pattern is
 * `lib/kb/legacy-path.ts`'s, the one `freshdeskFolderId` reads the id with,
 * and that module says why it is anchored at neither end.
 */
const LEGACY_FOLDER = FRESHDESK_FOLDER;

/**
 * Paths served as themselves on the help-centre hostname, rather than being
 * rewritten under /help.
 *
 * `/api` and `/_next` are the app's own plumbing, which every surface needs.
 * `/widget` joins them because the help centre now carries the chat launcher:
 * the snippet and the iframe are fetched from whichever hostname served the
 * page, so on the custom domain they would be rewritten to /help/widget and
 * 404 — chat working on the service URL and silently missing on the domain
 * customers actually visit.
 */
const KB_HOST_PASSTHROUGH = ['/api', '/_next', '/widget'];

/**
 * The two files a crawler asks a host for at its root, served by the help
 * centre (`app/help/robots.txt`, `app/help/sitemap.xml`) on every hostname.
 *
 * The help-centre hostname reaches them through its catch-all rewrite. Every
 * other host answered 404 for both until 2026-11-10. A crawler on the Render
 * host therefore found no robots file, and could crawl the tracking page, whose
 * every useful URL carries somebody's parcel number. The `Sitemap:` line, read
 * at `/help/robots.txt`, named a `/sitemap.xml` that 404s. The help centre's
 * pages are public on every host, and their canonicals name whichever host
 * `publicBaseUrl()` does, so its crawl rules and its sitemap belong on every
 * host too, as a locale path does below.
 */
const CRAWLER_FILES = new Set(['/robots.txt', '/sitemap.xml']);

function underPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isPublic(pathname: string): boolean {
  return underPrefix(pathname, PUBLIC_PREFIXES);
}

export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const host = request.headers.get('host')?.split(':')[0]?.toLowerCase() ?? '';
  const kbHost = process.env.KB_PUBLIC_HOST?.toLowerCase();

  // --- Legacy Freshdesk links ---------------------------------------------
  // An article, a folder or a category: each names a row, so finding where it
  // went is a lookup. Handled before anything else so they resolve on either
  // hostname, and ahead of the portal's rules below, which no longer read a
  // category. A category's page is `/<locale>/c/<slug>`, and Render's log
  // showed its URL followed on `support.shipblu.com` 8 times in the night
  // after the move. It asks `freshdeskCategoryId`, the function the route reads
  // the id with, so this cannot send a path the route reads no id from. The
  // lookup needs the database, so this hands off to a route handler rather
  // than doing it here.
  if (
    LEGACY_ARTICLE.test(pathname) ||
    LEGACY_FOLDER.test(pathname) ||
    freshdeskCategoryId(pathname) !== null
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/help/legacy';
    url.search = '';
    // In a header on the rewritten request, not `?path=` on its URL: the route
    // handler is handed the request as it arrived, so a query added here never
    // reaches it, and every legacy URL answered 404 (`lib/kb/legacy-path.ts`).
    // Set, not appended, so a value the client sent is replaced by the path it
    // actually asked for.
    const headers = new Headers(request.headers);
    headers.set(LEGACY_PATH_HEADER, pathname);
    return NextResponse.rewrite(url, { request: { headers } });
  }

  // Before the host split, because the help-centre hostname rewrites
  // everything it does not pass through.
  if (HEAD_FILE.test(pathname)) return NextResponse.next();

  // --- Freshdesk's portal pages --------------------------------------------
  // Its home, knowledge-base index, ticket form, sign-in and search, which
  // customers' bookmarks and Freshdesk's own emails still name. Here, on every
  // host, because what comes after answers them wrongly: the help-centre
  // host's catch-all and the locale rewrite with the help centre's 404, and the
  // console's check with its sign-in. Each has a counterpart that needs no
  // lookup, so no route handler; `lib/kb/freshdesk-portal.ts` says which, and
  // why every answer is a 302.
  const portal = freshdeskPortalRedirect(pathname, request.nextUrl.searchParams);
  if (portal) {
    // An absolute URL on `nextUrl`'s origin, and not the relative `Location`
    // `lib/http/redirect.ts` builds for a route handler. Next parses a proxy's
    // `Location` with no base, so a relative one throws (`ERR_INVALID_URL`) and
    // the request answers 500. One on the proxy's own origin it makes relative
    // before it goes out, so `/ar#contact` is what the browser gets, as for the
    // sign-in redirect below. That origin is not the host the request named:
    // under `next start` it is the server's listen address, `localhost:<port>`,
    // so it is safe only in a `Location` Next relativises. A plain URL rather
    // than a clone of `nextUrl`, because a clone remembers that the path it was
    // asked for ended in `/` and puts the slash back on whatever path it is
    // given.
    return NextResponse.redirect(new URL(portal, request.nextUrl.origin), 302);
  }

  // --- Help centre hostname ------------------------------------------------
  if (kbHost && host === kbHost) {
    if (underPrefix(pathname, KB_HOST_PASSTHROUGH)) {
      return NextResponse.next();
    }

    // Everything else here is the help centre. The console is not served on
    // this hostname at all: serving it on both would give every console page
    // two URLs, one of them public-looking.
    const url = request.nextUrl.clone();
    url.pathname = pathname === '/' ? '/help' : `/help${pathname}`;
    return NextResponse.rewrite(url);
  }

  if (CRAWLER_FILES.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/help${pathname}`;
    return NextResponse.rewrite(url);
  }

  // A locale-prefixed path is a help centre URL wherever it arrives. Without
  // this the public site would work only on the host `KB_PUBLIC_HOST` names,
  // which makes it unreviewable on the Render URL and unbrowsable in
  // development, and leaves a domain pointed here before the variable names it
  // (support.shipblu.com on 2026-11-12) with its front door and every article
  // address asking for a password, the help centre answering only under /help.
  // `/en` and `/ar` are not console routes, so nothing collides.
  if (LOCALE_PREFIX.test(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = `/help${pathname}`;
    return NextResponse.rewrite(url);
  }

  // --- Console auth --------------------------------------------------------

  // The bare domain is the help centre's front door on every hostname, so it is
  // public even though nothing beneath it is: `app/page.tsx` redirects it to the
  // default locale, which the locale rule above then rewrites under /help. Left
  // to the check below it would redirect to /login instead, and the front door
  // of a public support site would ask for a password.
  if (pathname === '/') return NextResponse.next();

  if (isPublic(pathname)) return NextResponse.next();

  if (request.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  // Preserve where they were going, so a shared ticket link survives sign-in.
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own static output, which never needs either job.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
