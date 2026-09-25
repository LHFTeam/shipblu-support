import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { interactionWindowSet } from './ingest-meta';

/**
 * A guard against a bug that only appears against a real database: a `Date`
 * bound as an untyped parameter.
 *
 * postgres.js cannot serialise one — it assumes text and throws
 * ERR_INVALID_ARG_TYPE — and drizzle only maps a Date when a typed operator
 * tells it the column. A `sql` template does not supply that. `toSQL()` shows
 * the difference without connecting to anything.
 *
 * The same shape as `sync-whatsapp-templates.test.ts`, and here for a sharper
 * reason: this statement runs only inside `process_meta_webhook`, which the
 * `database` CI job does not execute, so production is otherwise the first
 * thing that would ever plan it. An `EXPLAIN` of the equivalent SQL typed out by
 * hand does not catch it either — the literal is a literal there, and the bug is
 * in what drizzle binds.
 */

// Building a query validates the environment but never opens a connection.
beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  resetEnvCache();
});

const AT = new Date('2026-09-06T10:00:00.000Z');

function built() {
  return db
    .update(conversations)
    .set(interactionWindowSet(AT))
    .where(eq(conversations.id, '00000000-0000-0000-0000-000000000000'))
    .toSQL();
}

describe('interactionWindowSet', () => {
  it('binds no raw Date', () => {
    expect(built().params.some((param) => param instanceof Date)).toBe(false);
  });

  it('binds the instant as an ISO string behind an explicit cast', () => {
    const { sql: text, params } = built();

    expect(params).toContain(AT.toISOString());
    // The cast is what makes the string a timestamptz rather than text; without
    // it Postgres compares a string against a timestamptz column.
    expect(text).toContain('::timestamptz');
  });

  it('never moves either column backwards', () => {
    const { sql: text } = built();

    expect(text).toContain('greatest');
    // Both columns, not just the customer one: the inbox sorts on last_message_at.
    expect(text).toContain('"last_message_at" = greatest');
    expect(text).toContain('"last_customer_message_at" = greatest');
  });
});
