import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * `column` moved forward to `at`, and never back.
 *
 * For the "when did anything last happen" columns an email ingest writes.
 * Deliveries are processed in no guaranteed order: the worker claims several at
 * once, and a failed attempt retries behind a later mail. Each is stamped with
 * when it reached us, so the one processed last is not always the newest.
 * Written plainly, it would drag the column back to its own older instant, and
 * the ticket would drop down the list just as the customer's newer mail landed.
 *
 * `greatest` ignores nulls, so a column nothing has written yet takes `at`. The
 * instant is bound as an ISO string behind `::timestamptz`, because a bare
 * `Date` in a `sql` template reaches postgres.js untyped (AGENTS.md, Tests).
 * `interactionWindowSet` in `ingest-meta.ts` is the same statement for Meta.
 */
export function latest(column: AnyPgColumn, at: Date): SQL {
  return sql`greatest(${column}, ${at.toISOString()}::timestamptz)`;
}
