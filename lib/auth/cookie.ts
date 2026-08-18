/**
 * The session cookie's name, alone in its own module.
 *
 * `proxy.ts` runs on the Edge runtime, where `node:crypto` does not exist.
 * Importing this constant from `session.ts` dragged the whole session module —
 * and through it argon2 and the database client — into the Edge bundle, which
 * builds with a warning today and would fail outright the moment the proxy did
 * anything with the value.
 */
export const SESSION_COOKIE = 'shipblu_session';
