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
  return new NextResponse(null, { status, headers: { Location: path } });
}
