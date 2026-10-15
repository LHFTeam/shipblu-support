import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { messages } from '@/db/schema';
import { WRAPPED_LABEL, PLACEHOLDER, WHITESPACE } from './customer-text';

/**
 * Keeps only the messages that carry words somebody wrote — the SQL twin of
 * `hasCustomerText` (`lib/tickets/customer-text.ts`), which says what our labels
 * look like and why a reader of somebody's last words looks past them.
 *
 * Built from that module's constants rather than spelled again, so a label has
 * one definition: each pattern goes to Postgres as a parameter and is read by
 * `~` as written, and `btrim` is handed the characters `trim()` removes rather
 * than its default of the space alone. `carries-customer-text.db.test.ts` runs
 * both halves over the same rows.
 *
 * It refuses an empty body as well, so a query needs no `btrim(...) <> ''`
 * beside it.
 */
export function carriesCustomerText(): SQL {
  const text = sql`btrim(${messages.bodyText}, ${WHITESPACE})`;
  return sql`(${text} <> '' and ${text} !~ ${PLACEHOLDER.source} and ${text} !~ ${WRAPPED_LABEL.source})`;
}
