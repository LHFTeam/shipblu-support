import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { jobs, webhookEvents } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { completedJobRetentionFilter, retentionBatch, webhookRetentionFilter } from './cleanup';

/**
 * No database. These read the statement back through `toSQL()`, which is the
 * only way to assert on a predicate this repo's CI never executes against real
 * rows: the `database` job runs `cleanup` against an empty schema, so it proves
 * the SQL *plans* and says nothing about what it selects.
 *
 * That gap is exactly how the bug these tests pin survived. The webhook clause
 * was `processed_at is not null and processed_at < …`, so a payload that failed
 * signature verification never got a `processed_at`, never matched, and was
 * never deleted — 4,648 rows on 2026-09-09, the oldest from 19 August.
 */
beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  resetEnvCache();
});

function webhookDelete() {
  return db.delete(webhookEvents).where(webhookRetentionFilter()).toSQL();
}

/**
 * The same statement with the table qualifier dropped, for the assertions that
 * are about the *order* of two conditions rather than the presence of one.
 * `"webhook_events"."processed_at"` between every operator makes those patterns
 * unreadable, and the qualifier is drizzle's business, not this predicate's.
 */
function webhookClauses() {
  return webhookDelete().sql.replaceAll('"webhook_events".', '');
}

describe('webhook retention', () => {
  it('deletes an unverified payload, which is the whole point of the fix', () => {
    const { sql: text } = webhookDelete();

    // The clause that did not exist. Without it a row with no `processed_at` is
    // matched by nothing and kept forever.
    expect(text).toContain('"signature_verified" = false');
    expect(text).toContain('"received_at" <');
  });

  it('keys the short clock on the signature, not on a missing timestamp', () => {
    // `processed_at is null` reads as "unverified" and is not: processing that
    // fails writes only `error`, so it also describes a verified delivery whose
    // job reached `dead` — kept forever by the filter below on the grounds that
    // it needs a human, with this row as the only thing left to replay. The
    // seven-day clock must therefore never be reachable by a verified row.
    expect(webhookClauses()).toMatch(/"signature_verified" = false\s+and\s+"received_at" </);
    expect(webhookClauses()).not.toMatch(
      /"processed_at" is null\s+and\s+"received_at" < now\(\) - interval '7/,
    );
  });

  it('still deletes a verified row whose processing never completed', () => {
    // The original bug was a row no clause could reach. This is the third
    // clause: unprocessed but verified, on the longer clock, so a stuck row is
    // kept as long as a processed one rather than forever.
    expect(webhookClauses()).toMatch(
      /"processed_at" is null\s+and\s+"signature_verified"\s+and\s+"received_at" </,
    );
  });

  it('still deletes a processed payload on its own longer clock', () => {
    const { sql: text } = webhookDelete();

    expect(text).toContain('"processed_at" is not null');
    expect(text).toContain("interval '30 days'");
  });

  it('keeps an unverified payload for days rather than a month', () => {
    const { sql: text } = webhookDelete();

    // Deliberately shorter, and for the opposite reason: a processed payload is
    // kept because it is useful, an unverified one only until somebody has had
    // a chance to look at why a channel went quiet.
    expect(text).toContain("interval '7 days'");
  });

  it('joins the three cases with or, not and', () => {
    const { sql: text } = webhookDelete();

    // The failure mode if this were `and`: nothing would ever match, because no
    // row is both processed and unprocessed. A predicate that deletes nothing
    // looks exactly like a predicate that has nothing to delete.
    expect(text).toMatch(/is not null[\s\S]*\bor\b[\s\S]*\bor\b[\s\S]*is null/);
    expect(text.match(/\bor\b/g)).toHaveLength(2);
  });

  it('binds no javascript Date, so the driver cannot be handed one', () => {
    const { params } = webhookDelete();

    // Both clocks are the server's `now()`. postgres.js cannot serialise a bare
    // Date — it assumes text and throws ERR_INVALID_ARG_TYPE — and drizzle only
    // maps one when a typed operator names the column, which a `sql` template
    // never does. Keeping the arithmetic server-side sidesteps that entirely,
    // and this asserts it stayed that way (AGENTS.md, under Tests).
    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toHaveLength(0);
  });
});

describe('job retention', () => {
  it('deletes completed jobs only, never a dead one', () => {
    const { sql: text, params } = db.delete(jobs).where(completedJobRetentionFilter()).toSQL();

    // A dead job is the record of something that actually failed and needs a
    // human. Widening this to any finished job would erase the evidence.
    expect(text).toContain("'completed'");
    expect(text).toContain('"completed_at" <');
    expect(text).toContain("interval '7 days'");
    expect(params.some((param) => param instanceof Date)).toBe(false);
  });
});

describe('retention batching', () => {
  /**
   * The regression these pin is not a wrong predicate but an unbounded one.
   *
   * `#153` put a 30-second deadline on every query and `#155` widened webhook
   * retention, both in the same release. The `webhook_events` delete already
   * took 25.5 s the night they shipped; four days later it crossed the
   * deadline and was cancelled with `57014`, and every night it failed left the
   * rows behind to slow the next attempt. Two nights out of five, while the
   * table grew from 402,172 rows to 440,587.
   *
   * Neither test can catch that recurring — Vitest runs no SQL, and the
   * `database` job runs this handler against an empty schema where one
   * statement and a thousand are indistinguishable. What they can hold is the
   * shape that makes the statement bounded, so removing the bound is a failing
   * test rather than a slow rediscovery in production.
   */
  it('bounds one webhook batch with a limit', () => {
    const { sql: text, params } = db
      .delete(webhookEvents)
      .where(retentionBatch(webhookEvents, webhookRetentionFilter()))
      .toSQL();

    expect(text).toContain('limit');
    // The bound is a parameter, not spliced text: the batch size is a module
    // constant today, which is not a reason to let it reach the parser.
    expect(params).toContain(5000);
  });

  it('selects the ids it deletes from the same table', () => {
    const { sql: text } = db
      .delete(jobs)
      .where(retentionBatch(jobs, completedJobRetentionFilter()))
      .toSQL();

    // A subquery naming the wrong table would delete by ids that mean nothing
    // there — and with a uuid key it would quietly match nothing rather than
    // fail, so this is checked rather than assumed.
    expect(text).toMatch(/delete from "jobs"[\s\S]*select "jobs"\."id" from "jobs"/);
  });

  it('keeps the retention predicate inside the batch, not beside it', () => {
    const { sql: text } = db
      .delete(webhookEvents)
      .where(retentionBatch(webhookEvents, webhookRetentionFilter()))
      .toSQL();

    // The predicate belongs to the *subquery*. Hoisted out, `limit` would pick
    // an arbitrary 5,000 rows of the whole table and the delete would take
    // them — retention turning into an indiscriminate trim, which on
    // webhook_events is customer message content.
    const subquery = text.slice(text.indexOf('select'));
    expect(subquery).toContain('signature_verified');
    expect(subquery).toContain('limit');
  });

  it('binds no javascript Date', () => {
    const { params } = db
      .delete(webhookEvents)
      .where(retentionBatch(webhookEvents, webhookRetentionFilter()))
      .toSQL();

    expect(params.some((param) => param instanceof Date)).toBe(false);
  });
});
