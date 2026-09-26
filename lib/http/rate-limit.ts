/**
 * Per-instance rate limiting for the public endpoints.
 *
 * It began as the guard on the knowledge base's view and feedback endpoints,
 * which the next two paragraphs are about, and now also stands in front of the
 * CSAT link, the widget, the tracking page and the public forms.
 *
 * The view and feedback endpoints are unauthenticated by necessity — the help
 * centre has no sign-in — so the only thing between them and a script is this.
 * In-memory rather than a table, for the same reason the sign-in throttle is:
 * writing a row per rejected request hands an attacker a cheaper way to hurt
 * the database than the endpoint itself.
 *
 * Neither endpoint does anything an attacker wants. The counters exist to keep
 * a bored script from inflating `view_count` or filling `kb_article_feedback`,
 * not to stop a determined adversary — which is why the limits are generous
 * and the failure mode is a quiet 429.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Bounded so a long-lived instance under spray does not grow without limit. */
const MAX_BUCKETS = 20_000;

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) prune(now);
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= limit;
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still full of live buckets: drop the oldest rather than refuse everyone.
  if (buckets.size >= MAX_BUCKETS) {
    const oldest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of oldest.slice(0, Math.floor(MAX_BUCKETS / 4))) buckets.delete(key);
  }
}

/**
 * Best-effort client address behind Render's proxy.
 *
 * Typed on the one method it uses rather than on `Request`, so a server
 * component can pass `await headers()` — Next's `ReadonlyHeaders` is not a
 * `Headers` and has no request to reach for, and the tracking page is a page
 * rather than a route handler. Copying four lines into it instead is how the
 * two ways of reading a client address drift apart.
 */
type HeaderSource = { get(name: string): string | null };

export function clientIpFrom(headers: HeaderSource): string {
  const forwarded = headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
}

export function clientIp(request: Request): string {
  return clientIpFrom(request.headers);
}
