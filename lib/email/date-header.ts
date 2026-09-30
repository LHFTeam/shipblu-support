/**
 * Reads a mail's `Date` header into an instant, or null.
 *
 * Null rather than an Invalid Date for anything that does not parse. An Invalid
 * Date reaching an insert throws `RangeError: Invalid time value`, so a header
 * the mail never had to get right to be delivered used to send the ingest job
 * to `dead`, and a hand replay of the stored delivery parsed the same bytes and
 * failed the same way.
 *
 * A string or nothing: both drivers read it off a payload that came out of a
 * `jsonb` column, where any instant is already a string.
 */
export function parseDateHeader(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
