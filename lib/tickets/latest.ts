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
 * `interactionWindowSet` in `ingest-meta.ts` builds the Meta window from it.
 */
export function latest(column: AnyPgColumn, at: Date): SQL {
  return sql`greatest(${column}, ${at.toISOString()}::timestamptz)`;
}

/**
 * `column` moved back to `at`, and never forward: the twin of `latest()` for a
 * "when did this first happen" stamp that a late-processed, older event can
 * still correct — `first_responded_at` when a reply typed on the WhatsApp
 * Business app is processed after a later one (`onAgentReply`).
 *
 * `least` ignores nulls, so a column nothing has written yet takes `at`. Bound
 * as `latest()` binds it, for its reason.
 */
export function earliest(column: AnyPgColumn, at: Date): SQL {
  return sql`least(${column}, ${at.toISOString()}::timestamptz)`;
}

/**
 * `column` set to `at` the first time, and never moved after that.
 *
 * The once-only twin of `latest()`, for a "when did this first happen" stamp:
 * `first_auto_replied_at` records that a customer was acknowledged at all, so a
 * second automated reply must not move it and make a rule keyed off it fire
 * again. Here beside `latest()` for the reason that one is — a bare `Date` in a
 * `sql` template is refused by postgres.js, and an inline copy of this coalesce
 * is exactly how `deliverAutomatedReply` came to bind one (`docs/PROJECT-STATE.md`
 * §6.84).
 */
export function firstAt(column: AnyPgColumn, at: Date): SQL {
  return sql`coalesce(${column}, ${at.toISOString()}::timestamptz)`;
}
