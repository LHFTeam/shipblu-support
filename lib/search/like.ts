/**
 * `%` and `_` are wildcards to ILIKE, and a backslash escapes them. A customer
 * called "100%" or a subject with an underscore would otherwise search for
 * something other than what was typed.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * The ILIKE pattern for "contains this text", with the text taken literally.
 *
 * One builder rather than `%${…}%` at each search, because the escaping was
 * written once and copied twice, and the fourth search — the knowledge base
 * admin list — was written without it: an underscore in its box matched any
 * character and a lone `%` matched every article.
 */
export function containing(value: string): string {
  return `%${escapeLike(value)}%`;
}
