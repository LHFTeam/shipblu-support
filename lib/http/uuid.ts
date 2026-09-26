const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a value from a request — a path segment, a form field, a query
 * parameter — is shaped like a uuid, checked before it reaches a query.
 *
 * Postgres answers a malformed uuid with error 22P02 rather than with no rows.
 * In a route that is a 500 for what is only a link to nothing; in a server
 * action it is a throw, and an action that throws returns no state at all — the
 * agent gets a blank failure where the form promises a sentence. Pure, so it is
 * safe on either side of the wire.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * A uuid out of a request, lower-cased, or null when it is not one.
 *
 * Postgres reads `0B6F…` and `0b6f…` as the same uuid; JavaScript's `===` does
 * not. So an id compared in code against a row's or a session's — the check
 * that stops an admin deactivating themselves was one — let the upper-case
 * spelling past a guard the query then applied to the very row it protects.
 * Canonical on the way in, every later comparison and every path built from it
 * agrees with what the database will match.
 */
export function canonicalUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null;
}
