import type { Locale } from '@/lib/kb/locale';

/**
 * Where to send someone after they sign in.
 *
 * Two rules, and both exist because sign-in forms are where open redirects live.
 * A `next` that is not a same-site *path* is discarded outright — `//evil.test`
 * is a protocol-relative URL, not a path, and a browser follows it off-site
 * while the link still looks like ours.
 */
export function safePath(next: unknown, fallback: string): string {
  const value = typeof next === 'string' ? next : '';
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  return value;
}

/**
 * The same, narrowed to somewhere a customer can actually go.
 *
 * A customer often arrives at the sign-in form carrying a `next` the console
 * put there — the middleware appends one to every signed-out console request.
 * Honouring it would send them to a page that bounces them straight back to
 * /login, which reads as a sign-in that silently failed. Anything outside their
 * own locale's help centre falls back to their tickets.
 */
export function customerPath(next: unknown, locale: Locale, fallback: string): string {
  const path = safePath(next, fallback);
  return path.startsWith(`/${locale}/`) || path === `/${locale}` ? path : fallback;
}
