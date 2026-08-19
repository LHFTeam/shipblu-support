/**
 * The session cookie names, alone in their own module.
 *
 * `proxy.ts` runs on the Edge runtime, where `node:crypto` does not exist.
 * Importing these constants from `session.ts` dragged the whole session module —
 * and through it argon2 and the database client — into the Edge bundle, which
 * builds with a warning today and would fail outright the moment the proxy did
 * anything with the value.
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
