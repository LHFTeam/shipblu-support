import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie';

/**
 * Cheap signed-out redirect.
 *
 * This runs on every request, on the Edge runtime, with no database access — so
 * it only checks that a session cookie is present. It cannot tell a revoked or
 * expired session from a live one; `requireAgent()` does that on the page
 * itself. The value here is that a signed-out visitor lands on /login instead
 * of watching a console shell render and then bounce.
 */
export default function proxy(request: NextRequest) {
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasCookie) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  // Preserve where they were going, so a shared ticket link survives sign-in.
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the auth pages, the webhooks (which authenticate by
  // signature, not cookie), health, and Next's own assets.
  matcher: [
    '/((?!login|setup|invite|api/webhooks|api/health|api/auth|_next/static|_next/image|favicon.ico).*)',
  ],
};
