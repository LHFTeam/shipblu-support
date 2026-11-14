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

/** Bounded so a long-lived instance under spray does not grow without limit. */
const MAX_BUCKETS = 20_000;

declare const wholeSeconds: unique symbol;

/**
 * A wait as `Retry-After` carries it: whole seconds, at least one. Only
 * `retryAfterSeconds` makes one, so a value that skipped the rounding — a
 * backoff in milliseconds divided by a thousand, a literal `0` — does not
 * compile where the header is written. Typed as a plain `number`, the rule
 * lived in a comment, and `Retry-After: 0.25` or `0` compiled: the first is no
 * value RFC 9110 allows, the second tells the client to ask again at once,
 * against a bucket that still refuses.
 */
export type RetryAfterSeconds = number & { readonly [wholeSeconds]: true };

/** The one rounding of a wait into `Retry-After`: a window with 200 ms left is "1", never "0". */
export function retryAfterSeconds(msLeft: number): RetryAfterSeconds {
  return Math.max(1, Math.ceil(msLeft / 1000)) as RetryAfterSeconds;
}

export type Admission = { allowed: boolean; resetInSeconds: RetryAfterSeconds };

/** A map of buckets with its own bound, and the three questions every caller asks of one. */
class BucketStore {
  private readonly buckets = new Map<string, Bucket>();

  admit(key: string, limit: number, windowMs: number, cost: number): Admission {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= MAX_BUCKETS) this.prune(now);
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += cost;
    return {
      allowed: bucket.count <= limit,
      resetInSeconds: retryAfterSeconds(bucket.resetAt - now),
    };
  }

  fits(key: string, limit: number, cost: number): boolean {
    const bucket = this.buckets.get(key);
    const used = bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
    return used + cost <= limit;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    // Still full of live buckets: drop the oldest rather than refuse everyone.
    if (this.buckets.size >= MAX_BUCKETS) {
      const oldest = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [key] of oldest.slice(0, Math.floor(MAX_BUCKETS / 4))) this.buckets.delete(key);
    }
  }
}

/**
 * Buckets keyed on what a caller writes — an address, a visitor's token — and
 * can therefore make up without end. Full, it drops its oldest quarter rather
 * than refuse everybody, which a spray of made-up keys can bring about on
 * purpose.
 */
const shared = new BucketStore();

/**
 * Buckets keyed on what an unauthenticated caller cannot make up: a plane, an
 * account the myBlu API's server plane vouched for, a session's identity. In a
 * store of their own, so a spray of forged addresses filling the shared one
 * evicts none of them: in the one map, about ten thousand forged requests
 * reset the API's server-plane and per-user mint buckets, and the mint cap
 * stopped binding. Bounded the same way, though nothing unauthenticated can
 * add to it.
 */
const vouched = new BucketStore();

/**
 * Whether one more request fits in `key`'s window.
 *
 * `cost` is for a budget counted in something other than requests — the
 * widget's uploads spend one per megabyte — so a request can cost more than
 * one. It is spent whether or not it fits, as a refused request always was.
 */
export function allow(key: string, limit: number, windowMs: number, cost = 1): boolean {
  return admit(key, limit, windowMs, cost).allowed;
}

/**
 * `allow`, and how long until the window turns.
 *
 * For an answer that has to say when to come back: the myBlu API's `429`
 * carries `Retry-After`, and its SDK waits exactly that long rather than
 * guessing (`plans/myblu-ticket-api.md`, _Limits_). `allow` keeps `resetAt` to
 * itself, and every caller before this one answered a bare 429.
 *
 * Whole seconds and at least one, as the header is: a window with 200 ms left
 * is "1", never "0", which a client would read as "ask again now" and spend a
 * request the bucket still refuses. A refused request is spent all the same,
 * so a client that ignores the answer stays refused until the window turns.
 */
export function admit(key: string, limit: number, windowMs: number, cost = 1): Admission {
  return shared.admit(key, limit, windowMs, cost);
}

/**
 * `admit`, in the store a forged address cannot reach (`vouched`). Only for a
 * key no unauthenticated caller can choose; anything keyed on an address or a
 * value a request carries before it is authenticated belongs in `admit`.
 */
export function admitVouched(key: string, limit: number, windowMs: number, cost = 1): Admission {
  return vouched.admit(key, limit, windowMs, cost);
}

/**
 * Whether `cost` more would still fit in `key`'s window, spending nothing.
 *
 * For a budget that should be charged only for work that happened: the widget
 * asks before it stores a visitor's files and spends (`allow`) only once they
 * are stored, so a send that failed — and said "try again" — costs nothing. Two
 * requests can both fit and then both spend; in-memory and per instance, as
 * this whole module is, that is the price of not holding a lock across a
 * multi-second upload.
 */
export function fits(key: string, limit: number, cost = 1): boolean {
  return shared.fits(key, limit, cost);
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

/** How many hops `forwardedChain` keeps, counted from the end. */
const KEPT_HOPS = 8;
/** An IPv6 address with a zone is under this; anything longer was written, not appended. */
const HOP_CHARS = 64;

/**
 * The `X-Forwarded-For` chain as it arrived, its last hops kept, for a row
 * that records who made a request rather than a key that limits it.
 *
 * Not `clientIpFrom`, which answers the first hop. Every proxy appends the
 * address that connected to it, so the first hop is whatever the caller sent
 * in the header, and the ones the platform's proxies wrote come after it.
 * That is a fair key for a limit, which bounds a careless script and not a
 * determined one, and no record at all: somebody minting a myBlu session with
 * a leaked server token can write the backend's own address there. How many
 * hops the platform appends depends on what stands in front of the service,
 * so the chain is kept rather than one hop picked from it. Its end is what the
 * caller did not choose; its start, bounded, is what they claimed.
 */
export function forwardedChain(headers: HeaderSource): string | null {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim().slice(0, HOP_CHARS))
    .filter(Boolean);
  return hops.length > 0 ? hops.slice(-KEPT_HOPS).join(', ') : null;
}
