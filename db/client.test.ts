import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getSql, instrumentClient, poolPressure } from '@/db/client';
import { env } from '@/lib/env';
import { withTestEnv } from '@/lib/testing/env';

/**
 * These tests do not open a connection. Two halves: the postgres.js internals
 * `deadline()` in `db/client.ts` is built on — none of them part of the
 * library's public types, so a version bump that renamed one would stop
 * bounding every query in the application without failing anything — and then
 * the wrapping itself, exercised through `getSql()` and `instrumentClient()`
 * rather than re-implemented here. The first version of this file only had the
 * first half, which left the shipped code path with no test at all: dropping
 * the patch entirely would have kept it green.
 *
 * Why we are in this position at all: postgres.js parks a query beyond `max` in
 * an unbounded, untimed array and returns a promise that never rejects. There is
 * no queue timeout to configure — the whole option surface is `max`, the three
 * connection timers, and the startup parameters — so the deadline has to be
 * ours, and it has to reach inside. See §62 and `plans/web-freeze-2026-09-08.md`.
 */
withTestEnv();

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

  it('throws the canceller promise away, which is why the deadline does not use cancel()', async () => {
    const query = pendingQuery();
    const settleable = query as unknown as { canceller: unknown };

    expect(typeof settleable.canceller).toBe('function');

    // `cancel()` is `this.canceller && (this.canceller(this), this.canceller =
    // null)`. The comma operator discards what the canceller returned — a
    // promise that, for a query already on the wire, rejects when the socket
    // carrying the CancelRequest is refused. Nothing can handle it, and Node 22
    // exits the process on an unhandled rejection. `cancelQuietly()` calls the
    // canceller directly for exactly this reason.
    expect(query.cancel()).toBeNull();
    expect(settleable.canceller).toBeNull();

    await expect(query as unknown as Promise<unknown>).rejects.toMatchObject({ code: '57014' });
  });

  it('gives every handle its own unsafe, so one patch cannot reach a transaction', () => {
    const one = postgres('postgres://localhost/test', { max: 1 });
    const two = postgres('postgres://localhost/test', { max: 1 });

    // The library's `Sql(handler)` factory declares `unsafe` inside itself and
    // assigns it onto the handle it returns, so each handle carries its own.
    // That is what makes patching one possible — and it is why patching the
    // pool alone left every statement inside `db.transaction()` unbounded:
    // `begin()` calls `scope()`, which calls `Sql(handler)` again.
    expect(Object.hasOwn(one, 'unsafe')).toBe(true);
    expect(one.unsafe).not.toBe(two.unsafe);
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

/** A query object with the completion hooks `deadline()` wraps, and nothing else. */
function fakeQuery() {
  return {
    resolve: (value: unknown) => value,
    reject: (error: unknown) => error,
    canceller: null,
  };
}

describe('the deadline the pool actually installs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a query from unsafe() to settle', () => {
    const sql = getSql();
    const before = poolPressure().inFlight;

    const query = sql.unsafe('select 1', []) as unknown as ReturnType<typeof fakeQuery>;

    // Relative, not absolute: the pool is a module singleton and another test
    // in this worker may have touched it. What matters is the delta.
    expect(poolPressure().inFlight).toBe(before + 1);

    query.resolve(['row']);

    expect(poolPressure().inFlight).toBe(before);
  });

  it('reports the peak with the time it happened', () => {
    const sql = getSql();
    const query = sql.unsafe('select 1', []) as unknown as ReturnType<typeof fakeQuery>;

    const { peak, peakAt } = poolPressure();

    // A high-water mark alone cannot say whether the pressure is now or was an
    // hour ago, and one spike would pin it for the life of the instance.
    expect(peak).toBeGreaterThan(0);
    expect(peakAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(peakAt!))).toBe(false);

    query.resolve(['row']);
  });

  it('cancels a query that outlives its deadline and rejects it with 57014', async () => {
    vi.useFakeTimers();

    const sql = getSql();
    const before = poolPressure().inFlight;
    const query = sql.unsafe('select 1', []);

    // Nothing was dispatched, so the cancel takes the queued branch and rejects
    // synchronously. This is the path the freeze needs: a query parked behind
    // ten busy slots, which postgres.js would otherwise wait on forever.
    vi.advanceTimersByTime(env().DB_QUERY_TIMEOUT_MS);

    await expect(query as unknown as Promise<unknown>).rejects.toMatchObject({ code: '57014' });
    expect(poolPressure().inFlight).toBe(before);
  });
});

describe('instrumenting a handle', () => {
  it('installs the deadline once, however many times it is asked', () => {
    const handle = { unsafe: () => fakeQuery() };

    instrumentClient(handle, 1_000);
    instrumentClient(handle, 1_000);

    const before = poolPressure().inFlight;
    const query = handle.unsafe();

    // Two increments here would be the dev hot-reload bug: `getSql()` adopts
    // the pool off `globalThis`, so a re-run module scope wraps the previous
    // scope's wrapper and every query arms N timers against N counters.
    expect(poolPressure().inFlight).toBe(before + 1);

    query.resolve(null);
    expect(poolPressure().inFlight).toBe(before);
  });

  it('reaches the fresh handle a transaction body is given, and counts it open', async () => {
    const scoped = { unsafe: () => fakeQuery() };
    const handle = {
      unsafe: () => fakeQuery(),
      // postgres.js hands the body a handle built by its own `Sql(handler)`,
      // not the one `begin` was called on. Stubbed rather than driven, because
      // the real `begin` issues a BEGIN and there is no database here.
      begin: (fn: (client: typeof scoped) => Promise<unknown>) => fn(scoped),
    };

    instrumentClient(handle, 1_000);

    const outside = poolPressure();
    expect(outside.transactions).toBe(0);

    await handle.begin(async (client) => {
      const inside = poolPressure();
      expect(inside.transactions).toBe(1);

      const query = client.unsafe();
      expect(poolPressure().inFlight).toBe(inside.inFlight + 1);
      query.resolve(null);

      return null;
    });

    // A transaction reserves one of the ten connections for its whole lifetime,
    // so this number is what stops `/api/health` reporting an idle pool while
    // every slot is held.
    expect(poolPressure().transactions).toBe(0);
  });
});
