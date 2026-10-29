/**
 * What a caught value says about itself, as one line of text.
 *
 * `catch` binds `unknown`: a library can throw a string, a plain object or
 * `undefined`, so `.message` cannot be read off it without a check, and
 * interpolating it whole prints a stack or `[object Object]` into a log line
 * or a stored `last_error`. The check had been written out by hand at every
 * catch that needed it; this is it once.
 *
 * Deliberately only the message. Where the stack is wanted — `failJob` keeps it
 * on the job row — the caller says so itself.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `query_canceled`: a statement cancelled, or given up on by the admission gate. */
const QUERY_CANCELED = '57014';

/**
 * Whether a caught value says its statement got no answer: `57014`, on the
 * value or on the `cause` drizzle wraps a driver's error in. The admission gate
 * in `db/client.ts` gives a statement up that way and has told the caller its
 * transaction failed, though the statement may yet commit; Postgres answers a
 * cancel with it too, a statement that ran into its deadline, and nothing
 * retries that inside a write that has already waited so long. So code that
 * swallows a failure inside a transaction — a savepoint rolled back to, the
 * write going on — throws this one on instead, and the transaction rolls back
 * rather than queue more behind it.
 */
export function gotNoAnswer(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return [error, cause].some(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === QUERY_CANCELED,
  );
}
