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
