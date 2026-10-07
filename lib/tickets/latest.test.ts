import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import { withTestEnv } from '@/lib/testing/env';
import { firstAt, latest } from './latest';

/**
 * The fast half of the check AGENTS.md asks of any `sql` fragment holding an
 * instant: that drizzle binds no raw `Date`, which postgres.js cannot serialise.
 * The slow half is `worker/handlers/process-webhook.db.test.ts`, which executes
 * the statement through the real ingest.
 */

// Building a query validates the environment but never opens a connection.
withTestEnv();

const AT = new Date('2026-09-20T07:30:00.000Z');

function built() {
  return db
    .update(conversations)
    .set({ lastMessageAt: latest(conversations.lastMessageAt, AT) })
    .where(eq(conversations.id, '00000000-0000-0000-0000-000000000000'))
    .toSQL();
}

describe('latest', () => {
  it('binds the instant as an ISO string behind an explicit cast, never a Date', () => {
    const { sql: text, params } = built();

    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toContain(AT.toISOString());
    expect(text).toContain('"last_message_at" = greatest("conversations"."last_message_at", $');
    expect(text).toContain('::timestamptz');
  });
});

describe('firstAt', () => {
  it('sets the column only while it is empty, binding the instant the same way', () => {
    const { sql: text, params } = db
      .update(conversations)
      .set({ firstAutoRepliedAt: firstAt(conversations.firstAutoRepliedAt, AT) })
      .where(eq(conversations.id, '00000000-0000-0000-0000-000000000000'))
      .toSQL();

    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toContain(AT.toISOString());
    expect(text).toContain(
      '"first_auto_replied_at" = coalesce("conversations"."first_auto_replied_at", $',
    );
    expect(text).toContain('::timestamptz');
  });
});
