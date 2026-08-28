/**
 * The origin customers actually see.
 *
 * Sitemap and canonical URLs must use the help-centre hostname, not the Render
 * service URL — a sitemap advertising shipblu-support.onrender.com would get
 * that hostname indexed instead, and split the site's search ranking across two
 * domains.
 */
export function publicBaseUrl(): string {
  const host = process.env.KB_PUBLIC_HOST;
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  // Local development and any deployment where the custom domain is not set up
  // yet. Falling back keeps the pages working; only the absolute URLs are off.
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Typed on the one method it uses, so a server component can pass
 * `await headers()` and a route handler can pass `request.headers`. Copied from
 * `clientIpFrom` in `./rate-limit.ts` for the same reason it exists there: the
 * two ways of reading a request drift apart the moment one of them is inlined.
 */
type HeaderSource = { get(name: string): string | null };

/** A bare hostname, optionally with a port. Not a URL, not a list. */
const HOSTNAME = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * The origin this request actually arrived on.
 *
 * Distinct from `publicBaseUrl()` above, and both are needed: that one is the
 * address we *publish* — sitemap, canonical tags, `metadataBase` — while this
 * one is the address somebody is *using*. An agent opening an article from the
 * console wants the second. Linking them to the first sends them to whichever
 * hostname `KB_PUBLIC_HOST` names, which is only right once that hostname
 * serves this app; until the domain cuts over it is a page that 404s, and no
 * amount of the link being canonically correct helps the person who clicked it.
 *
 * Read off the `Host` header, never off `request.url`. Next resolves
 * `request.url` against the address the server is *bound* to, so behind Render
 * a request for any hostname reports `http://localhost:10000/...` — the bug
 * that once redirected signed-out agents to a dead address on their own
 * machine. `lib/http/redirect.ts` carries the long version.
 *
 * The host is attacker-controllable in principle, and this string ends up in a
 * message sent to a customer, so it is worth being explicit about why that is
 * bounded here: Render's edge routes to this service only for the hostnames
 * configured on it, so a forged `Host` does not arrive in the first place, and
 * anything that is not a bare hostname is rejected below. An allowlist would be
 * the belt-and-braces answer, but the only entries it could hold are
 * `KB_PUBLIC_HOST` and the host of `APP_URL` — and `APP_URL` is `sync: false`,
 * so it cannot be checked from the repository at all.
 */
export function requestBaseUrl(headers: HeaderSource): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host || !HOSTNAME.test(host)) return publicBaseUrl();

  // A comma-separated list when more than one proxy has handled it; the first
  // entry is the scheme the client actually used.
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded || (host.startsWith('localhost') ? 'http' : 'https');

  return `${scheme}://${host}`;
}
