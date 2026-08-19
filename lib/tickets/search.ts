/**
 * What an agent's search box entry means.
 *
 * Parsing lives here rather than inline in the query so it can be tested
 * without a database, and so the inbox and anything else that grows a search
 * agree on what "#812" or a pasted phone number is.
 */

export type SearchTerm = {
  /** ILIKE pattern for free-text columns. Wildcards in the query are literal. */
  pattern: string;
  /**
   * The ticket number the query names, if it names one. "#812" is how the team
   * refers to a ticket, so it earns an exact match on the number rather than a
   * substring search that happens to hit a subject.
   */
  number: number | null;
  /**
   * A digits-only pattern for phone columns, set only when the query carries
   * punctuation the stored number does not. Numbers arrive in E.164 digits
   * (`201014428154`), but agents paste them the way WhatsApp and the shipping
   * system show them — `+20 101 442 8154`, `0101-442-8154` — and every one of
   * those matched nothing.
   */
  phonePattern: string | null;
};

/** Anything that shows up between the digits of a written-down phone number. */
const PHONE_PUNCTUATION = /^[\d+()\-.\s]+$/;

/**
 * `%` and `_` are wildcards to ILIKE, and a backslash escapes them. A customer
 * called "100%" or a subject with an underscore would otherwise search for
 * something other than what was typed.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function parseSearchTerm(query: string): SearchTerm {
  const q = query.trim();

  const asTicket = /^#?(\d+)$/.exec(q);
  // Number() would also accept "1e3" and " 12.0 ", which are not ticket
  // numbers anybody types. Postgres bigints are what this is compared against,
  // so anything past the safe integer range is not one either.
  const number =
    asTicket && Number(asTicket[1]) > 0 && Number(asTicket[1]) <= Number.MAX_SAFE_INTEGER
      ? Number(asTicket[1])
      : null;

  const digits = q.replace(/\D/g, '');
  const looksLikePhone = PHONE_PUNCTUATION.test(q) && digits.length >= 6;

  return {
    pattern: `%${escapeLike(q)}%`,
    number,
    // Only when the punctuation actually got in the way: for a query that is
    // already bare digits the free-text pattern covers the phone column too.
    phonePattern: looksLikePhone && digits !== q ? `%${digits}%` : null,
  };
}
