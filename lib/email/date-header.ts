/**
 * Reads a mail's `Date` header into an instant, or null.
 *
 * Null rather than an Invalid Date for anything that does not parse. An Invalid
 * Date reaching an insert throws `RangeError: Invalid time value`, so a header
 * the mail never had to get right to be delivered used to fail the ingest job on
 * every retry and lose the message.
 *
 * A `Date` is accepted as well as a string because the `local` driver is handed
 * payloads built in-process as well as posted as JSON.
 */
export function parseDateHeader(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
