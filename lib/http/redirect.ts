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
 *
 * Not for `proxy.ts`. Next parses a proxy's `Location` with no base URL, so a
 * relative one throws `ERR_INVALID_URL` there and the request answers 500. A
 * proxy redirects to an absolute URL on `request.nextUrl.origin` instead, and
 * Next makes it relative on the way out, because it compares it with that same
 * origin: the `Location` this builds, reached the other way round. That origin
 * is the listen address in the proxy too, the trap above, so it belongs only in
 * a `Location` Next relativises.
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
 *
 * Matched a code point at a time (`u`), not a UTF-16 unit: `slugify` keeps an
 * emoji, which is two units, and either half alone makes `encodeURIComponent`
 * throw `URI malformed`, the 500 this exists to prevent. A half that arrives
 * alone, with no pair to make a code point, becomes U+FFFD first, as
 * `toWellFormed()` would make it (ES2024, past this project's `lib`). Nothing
 * read back from Postgres can hold one, since a UTF-8 column stores none, but
 * a path built in code could.
 */
function headerSafe(path: string): string {
  return path
    .replace(/\p{Cs}/gu, '\uFFFD')
    .replace(/[^\x00-\x7F]/gu, (char) => encodeURIComponent(char));
}
