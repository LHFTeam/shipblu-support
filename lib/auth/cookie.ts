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
