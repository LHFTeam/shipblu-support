import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { stripTashkeel } from '@/lib/kb/seed';
import { stripInvisible } from '@/lib/shipments/format';
import { arabicVariantPattern } from './arabic';
import { containing } from './like';

/**
 * Matching what somebody typed against a column people write in.
 *
 * One module for every free-text search in the console, because the answer to
 * "does احمد find أحمد" was once different in each of them: the inbox widened
 * Arabic letters and the contact search, the merge picker and the knowledge
 * base list did not, so the same agent typing the same name found a customer in
 * one box and not in the next. A search choosing between the ILIKE and the
 * widened form for itself is how that happens again.
 */

/**
 * What a paste brings along that the stored text does not have.
 *
 * A name copied out of an RTL WhatsApp message carries a U+200F, which `trim()`
 * keeps because it is a format character rather than whitespace, and it made
 * the query match nobody. Tatweel and tashkeel are decoration a writer may or
 * may not use; the columns are searched as stored, and they are stored without
 * them far more often than with, so a query keeping one misses the plain
 * spelling of the same word.
 *
 * A search decides whether it has a query on this answer, not on its input: a
 * query that is only a U+200F, a tatweel or a fatha cleans to '', and `%%`
 * matches every row that has any text at all.
 */
export function cleanQuery(query: string): string {
  return stripTashkeel(stripInvisible(query)).trim();
}

/** A query prepared once for every column it is matched against. */
export type TextPatterns = {
  /** ILIKE pattern for "contains this text". Wildcards in the query are literal. */
  pattern: string;
  /**
   * A `~*` pattern that stands in for `pattern` on the columns people write
   * Arabic in, set only when the query holds a letter with spelling variants.
   * "احمد" otherwise misses every أحمد in the contact list — 31 of them in
   * production, beside 98 spelled احمد — and "الشحنه" every message that wrote
   * الشحنة. See `arabicVariantPattern` for why the query is widened rather than
   * the column folded.
   */
  arabicPattern: string | null;
};

export function textPatterns(query: string): TextPatterns {
  const q = cleanQuery(query);
  return { pattern: containing(q), arabicPattern: arabicVariantPattern(q) };
}

/**
 * Whether a column people write in contains the query.
 *
 * The widened form only when the query has something to widen, so every query
 * with no Arabic variant letter keeps exactly the ILIKE it had. The same
 * trigram index serves both. For columns nobody writes Arabic in — an email, a
 * phone number, a tracking number — use `ilike(column, patterns.pattern)`.
 */
export function textMatches(
  column: AnyColumn | SQL,
  { pattern, arabicPattern }: TextPatterns,
): SQL {
  return arabicPattern ? sql`${column} ~* ${arabicPattern}` : sql`${column} ILIKE ${pattern}`;
}
