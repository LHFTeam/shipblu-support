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
  '/api/auth',
  '/api/kb',
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

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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
    // The console is not served on this hostname at all. Serving it on both
    // would give every console page two URLs, one of them public-looking.
    if (pathname.startsWith('/api/') || pathname.startsWith('/_next')) {
      return NextResponse.next();
    }

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
