import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie';

/**
 * Two jobs, both of which have to happen before anything touches a database.
 *
 * 1. Host routing. One Next app serves two surfaces: the agent console and the
 *    public help centre. Requests arriving on the help-centre hostname are
 *    rewritten under `/kb`, so support.shipblu.com/en/a/foo renders
 *    /kb/en/a/foo while the URL the customer sees stays clean.
 *
 * 2. The signed-out redirect for the console. This runs on the Edge runtime
 *    with no database access, so it only checks that a session cookie exists —
 *    it cannot tell a revoked session from a live one. `requireAgent()` does
 *    that on the page itself. The value here is that a signed-out visitor
 *    lands on /login instead of watching a console shell render and bounce.
 */

/** Paths that are public on every hostname. */
const PUBLIC_PREFIXES = [
  '/help',
  '/login',
  '/setup',
  '/invite',
  '/api/webhooks',
  '/api/health',
  // The page `/api/health` renders to prove that rendering works. Fetched over
  // the loopback by the health check, which carries no session — left to the
  // cookie check below it would answer 307 to /login, and a redirect that
  // Render's five-second budget resolves to somebody else's HTML is a health
  // check that passes while every real page is dead.
  '/probe',
  '/api/auth',
  '/api/kb',
  // The widget page and every endpoint it calls. Both halves are needed: the
  // iframe loads /widget, then fetches /api/widget/* with no session cookie,
  // and a missing entry here turns each of those calls into a redirect to
  // /login that the widget cannot follow.
  '/api/widget',
  '/widget',
  '/robots.txt',
  '/sitemap.xml',
  '/_next',
  '/favicon.ico',
];

/**
 * Freshdesk article URLs, in every prefix variant an account can be configured
 * with (`/support/solutions/...`, `/a/solutions/...`, bare `/solutions/...`).
 * Matching on the article id rather than the whole path is what makes one rule
 * cover all of them — the trailing title text changes whenever someone edits
 * the title, so it was never a reliable key.
 */
const LEGACY_ARTICLE = /\/solutions\/articles\/(\d+)/;

/** `/en`, `/ar`, and anything beneath them. Kept in step with LOCALES. */
const LOCALE_PREFIX = /^\/(en|ar)(\/|$)/;
const LEGACY_FOLDER = /\/solutions\/folders\/(\d+)/;

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
  // Handled before anything else so they resolve on either hostname. The
  // lookup itself needs the database, so this hands off to a route handler
  // rather than doing it here.
  const legacyArticle = LEGACY_ARTICLE.exec(pathname);
  const legacyFolder = legacyArticle ? null : LEGACY_FOLDER.exec(pathname);

  if (legacyArticle || legacyFolder) {
    const url = request.nextUrl.clone();
    url.pathname = '/help/legacy';
    url.search = `?path=${encodeURIComponent(pathname)}`;
    return NextResponse.rewrite(url);
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

  // A locale-prefixed path is a help centre URL wherever it arrives. Without
  // this the public site would only work once the custom domain is live, which
  // makes it unreviewable on the Render URL and unbrowsable in development.
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
