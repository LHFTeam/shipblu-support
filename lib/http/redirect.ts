import { NextResponse } from 'next/server';

/**
 * A redirect whose `Location` stays relative.
 *
 * `NextResponse.redirect()` demands an absolute URL, and the obvious way to
 * produce one in a route handler — `new URL(path, request.url)` — is a trap.
 * Next resolves `request.url` against the address the server is *bound* to
 * rather than the `Host` it was asked for, and no proxy header changes that:
 * with `Host: support.shipblu.com` the handler still sees
 * `http://localhost:10000/...`. Behind Render that put the internal listen
 * address straight into `Location`, so signing out sent the agent to
 * `http://localhost:10000/login` — a dead address on their machine.
 *
 * A relative `Location` is explicitly allowed (RFC 7231 §7.1.2) and is
 * resolved by the browser against the URL it actually requested, which is the
 * only thing that knows which of our three hostnames this is — the custom
 * domain, the Render service URL, or localhost. So it is not merely a
 * workaround for the trap above; it is the form that is correct on all of them.
 */
export function redirectTo(path: string, status: 301 | 302 | 303 | 307 | 308): NextResponse {
  return new NextResponse(null, { status, headers: { Location: headerSafe(path) } });
}

/**
 * Percent-encodes the bytes a `Location` header cannot carry, and nothing else.
 *
 * A header value is a ByteString: anything above 0xFF throws
 * `Cannot convert argument to a ByteString`, which surfaces as a 500 rather
 * than a redirect. `slugify` deliberately preserves Arabic and Arabic is the
 * default locale — 58 of the 112 articles in production have a non-ASCII slug —
 * so an un-encoded path here is a 500 on the ordinary case, not an edge one.
 * `encodeSlugParam` exists for callers that build a path from a slug; this is
 * the backstop at the one place every redirect actually passes through, so a
 * caller that forgets cannot produce a 500.
 *
 * Only non-ASCII is touched, which is what makes it safe to apply to a path
 * that is *already* encoded: `%` is ASCII, so a `%D8` sequence is left alone
 * rather than becoming `%25D8`. `encodeURI` would double-encode it, and
 * `kb_redirects.to_path` is typed by an admin and may arrive either way.
 */
function headerSafe(path: string): string {
  return path.replace(/[^\x00-\x7F]/g, (char) => encodeURIComponent(char));
}
