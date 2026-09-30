/**
 * The session cookie names, alone in their own module.
 *
 * `proxy.ts` needs these two names and nothing else. Importing them from
 * `session.ts` would take the whole session module into the proxy's bundle — and
 * through it the database client and every table definition — for two string
 * constants, in the one module that runs in front of every request. Next 16 runs
 * the proxy on Node.js, so that import would build; this module is what keeps it
 * from being needed.
 */

/** Agent console. */
export const SESSION_COOKIE = 'shipblu_session';

/**
 * Customer portal. A second cookie rather than one shared with the console:
 * the two populations are authenticated against different tables, and a
 * colleague who also emails support can hold both at once without either
 * sign-in evicting the other.
 */
export const CUSTOMER_SESSION_COOKIE = 'shipblu_customer';

/**
 * Whether a request comes from a browser signed in to the console.
 *
 * For the help centre's public counters, which exist to say what customers
 * read and found useful: the inbox links agents straight to the help centre,
 * and a team re-reading the same few procedures all day would otherwise rank
 * them on the public front page. The cookie's presence rather than a live
 * session, because looking the session up would put a query on a public
 * endpoint to answer a question whose worst wrong answer — a forged cookie —
 * only stops the forger's own view or vote being counted.
 *
 * An empty value is no session, as it is to `proxy.ts` and `getSessionAgent`,
 * so there is one meaning of "signed in" rather than three. Read off the
 * `Cookie` header rather than `NextRequest.cookies`, so a route keeps taking a
 * plain `Request`. On the help-centre hostname the console's cookie is never
 * sent, so this knows only about readers who came from the console on its own
 * host — which is where the inbox link sends them.
 */
export function hasConsoleSession(headers: { get(name: string): string | null }): boolean {
  const header = headers.get('cookie');
  if (!header) return false;
  return header.split(';').some((pair) => {
    const separator = pair.indexOf('=');
    if (separator < 0) return false;
    return (
      pair.slice(0, separator).trim() === SESSION_COOKIE && pair.slice(separator + 1).trim() !== ''
    );
  });
}
