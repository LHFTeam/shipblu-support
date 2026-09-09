import { beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resetEnvCache } from '@/lib/env';

/**
 * These tests do not open a connection. They pin the two postgres.js internals
 * that `deadline()` in `db/client.ts` is built on, because neither is part of
 * the library's public types and a version bump that renamed either one would
 * stop bounding every query in the application without failing anything.
 *
 * Why we are in this position at all: postgres.js parks a query beyond `max` in
 * an unbounded, untimed array and returns a promise that never rejects. There is
 * no queue timeout to configure — the whole option surface is `max`, the three
 * connection timers, and the startup parameters — so the deadline has to be
 * ours, and it has to reach inside. See §62 and `plans/web-freeze-2026-09-08.md`.
 */
beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  resetEnvCache();
});

/** A query object, built the way drizzle builds every one of its queries. */
function pendingQuery() {
  // Never awaited, so `handle()` never runs and nothing is dispatched: the
  // object under test here is the query, not a round trip.
  const sql = postgres('postgres://localhost/test', { max: 1, prepare: false });
  return sql.unsafe('select 1', []);
}

describe('the postgres.js seams the query deadline depends on', () => {
  it('exposes resolve and reject as own properties the handler calls', () => {
    const query = pendingQuery() as unknown as Record<string, unknown>;

    // `deadline()` wraps these rather than calling `.then()`. Calling `.then()`
    // would run postgres.js's `handle()` and dispatch the query immediately,
    // which races the `.values()` that drizzle chains on the very next
    // expression — that lands in time today only because `handle()` defers by
    // one microtask, and a deadline is not worth hanging on a microtask.
    expect(typeof query.resolve).toBe('function');
    expect(typeof query.reject).toBe('function');
    expect(Object.hasOwn(query, 'resolve')).toBe(true);
    expect(Object.hasOwn(query, 'reject')).toBe(true);
  });

  it('exposes cancel, which is the only thing that reaches a queued query', () => {
    const query = pendingQuery();

    // For a query still in the wait queue this removes it and rejects with
    // 57014; for one already sent it opens a *separate* socket to send a
    // protocol CancelRequest. The second half is what makes it usable at all
    // when the pool itself is what has run out.
    expect(typeof query.cancel).toBe('function');
  });

  it('leaves values() chainable, because the deadline must not consume the query', () => {
    const query = pendingQuery();

    // drizzle's postgres-js session calls `client.unsafe(text, params).values()`
    // for row-mode results. Anything that wrapped the query in a bare promise
    // would lose this and break every select in the application.
    expect(typeof query.values).toBe('function');
    expect(query.values()).toBe(query);
  });

  it('is a promise subclass whose then() yields a plain promise', () => {
    const query = pendingQuery();

    // Why `deadline()` returns the original query rather than anything derived
    // from it: postgres.js sets Symbol.species to Promise, so a `.then()` chain
    // gives back something without `cancel` or `values`.
    expect(query).toBeInstanceOf(Promise);
  });
});

describe('deadline bookkeeping', () => {
  it('decrements on the settle path the handler actually uses', async () => {
    const query = pendingQuery() as unknown as {
      resolve: (value: unknown) => unknown;
      reject: (error: unknown) => unknown;
    };

    // The same wrapping `deadline()` performs, in miniature: prove that calling
    // the library's own `resolve` runs our hook and still settles the promise.
    // If postgres.js ever stopped routing completion through these, the counter
    // would leak upward and the timer would never be cleared — a query deadline
    // that fires on a query that finished long ago.
    let settled = 0;
    const { resolve } = query;
    query.resolve = (value) => ((settled += 1), resolve.call(query, value));

    query.resolve(['row']);

    expect(settled).toBe(1);
    await expect(query as unknown as Promise<unknown>).resolves.toEqual(['row']);
  });

  it('routes a cancelled queued query through reject', async () => {
    const query = pendingQuery();
    const settleable = query as unknown as { reject: (error: unknown) => unknown };

    let settled = 0;
    const { reject } = settleable;
    settleable.reject = (error) => ((settled += 1), reject.call(settleable, error));

    // Nothing has been dispatched, so this is the queued-query branch: cancel
    // rejects it synchronously with 57014 rather than waiting for a slot.
    query.cancel();

    await expect(query as unknown as Promise<unknown>).rejects.toMatchObject({ code: '57014' });
    expect(settled).toBe(1);
  });
});
