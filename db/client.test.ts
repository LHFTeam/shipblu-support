import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
  ADMIT_MAX,
  allPoolPressures,
  pressureOf,
  getSql,
  instrumentClient,
  poolPressure,
} from '@/db/client';
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

    const query = handle.unsafe();

    // Two here would be the dev hot-reload bug: `getSql()` adopts the pool off
    // `globalThis`, so a re-run module scope wraps the previous scope's wrapper
    // and every query arms N timers against N counters.
    expect(pressureOf(handle).inFlight).toBe(1);

    query.resolve(null);
    expect(pressureOf(handle).inFlight).toBe(0);
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

    expect(pressureOf(handle).transactions).toBe(0);

    await handle.begin(async (client) => {
      const inside = pressureOf(handle);
      expect(inside.transactions).toBe(1);

      // Counted on the pool the transaction belongs to, not on the fresh handle.
      const query = client.unsafe();
      expect(pressureOf(handle).inFlight).toBe(inside.inFlight + 1);
      query.resolve(null);

      return null;
    });

    // A transaction reserves one of the ten connections for its whole lifetime,
    // so this number is what stops `/api/health` reporting an idle pool while
    // every slot is held.
    expect(pressureOf(handle).transactions).toBe(0);
  });
});

/**
 * A query as postgres.js builds one, reduced to the members the gate touches.
 *
 * `start()` stands in for postgres.js's own `handle()`, which calls `handler`
 * once a microtask after the query is first awaited. The canceller does what
 * postgres.js's does for a query it has not sent — reject it with 57014 — and,
 * for one it has, what a pooler that lost the reply does: nothing.
 */
function gatedQuery(
  dispatched: string[],
  label: string,
  options: {
    connecting?: boolean;
    /** What else hears the library's own settle — postgres.js's begin(), for its BEGIN. */
    settled?: (outcome: 'resolved' | 'rejected', value: unknown) => void;
  } = {},
) {
  const query = {
    sent: false,
    cancelled: null as unknown,
    /** postgres.js sets these when it writes the query to a connection. */
    state: null as unknown,
    active: false,
    cancels: 0,
    handler: (_self: unknown) => {
      dispatched.push(label);
      // A connection still connecting holds its first query unsent.
      if (!options.connecting) query.run();
    },
    /** The connection writes it and starts answering it. */
    run: () => {
      query.sent = true;
      query.state = { pid: 1, secret: 1 };
      query.active = true;
    },
    canceller: (self: { reject: (error: unknown) => unknown }) => {
      query.cancels += 1;
      if (query.sent) return Promise.resolve();
      query.cancelled = true;
      self.reject(
        Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
      );
      return Promise.resolve();
    },
    /** What the caller was told, through the library's own reject. */
    rejectedWith: null as unknown,
    resolve: (value: unknown) => {
      options.settled?.('resolved', value);
      return value;
    },
    reject: (error: unknown) => {
      query.rejectedWith = error;
      options.settled?.('rejected', error);
      return error;
    },
    start: () => query.handler(query),
  };
  return query;
}

/** A pool handle whose `unsafe` hands out `gatedQuery`s, labelled in order. */
function gatedPool(admit: number, timeoutMs = 1_000, lostAfterMs = 500, connecting = false) {
  const dispatched: string[] = [];
  let next = 0;
  const handle = {
    unsafe: () => gatedQuery(dispatched, `q${next++}`, { connecting }),
  };
  instrumentClient(handle, timeoutMs, { admit, lostAfterMs });
  return { handle, dispatched, unsafe: () => handle.unsafe() as ReturnType<typeof gatedQuery> };
}

/** Lets every queued microtask run. */
const microtasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the admission gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets in no more than its size, and the rest in the order they asked', () => {
    const { handle, dispatched, unsafe } = gatedPool(2);
    const queries = [unsafe(), unsafe(), unsafe(), unsafe()];
    for (const query of queries) query.start();

    expect(dispatched).toEqual(['q0', 'q1']);
    expect(pressureOf(handle)).toMatchObject({ admitted: 2, waiting: 2, lost: 0, admitMax: 2 });

    for (const query of queries) query.resolve(null);
  });

  it('hands a place on only after the settling query has returned', async () => {
    const { dispatched, unsafe } = gatedPool(1);
    const first = unsafe();
    const second = unsafe();
    first.start();
    second.start();

    // postgres.js settles a query inside its ReadyForQuery handler and only
    // then moves the connection back to `open`. A place handed on here, inside
    // that call, would dispatch the next query while every connection still
    // looked busy — the pipelining the gate exists to prevent.
    first.resolve(['row']);
    expect(dispatched).toEqual(['q0']);

    await microtasks();
    expect(dispatched).toEqual(['q0', 'q1']);
    second.resolve(['row']);
  });

  it('never sends a query cancelled while it waited, and gives its place back', async () => {
    vi.useFakeTimers();
    const { handle, dispatched, unsafe } = gatedPool(1, 100);
    const holder = unsafe();
    const waiter = unsafe();
    holder.start();
    waiter.start();

    vi.advanceTimersByTime(100);
    // The holder was sent, so its cancel went to a pooler that did nothing;
    // the waiter was not, so postgres.js's own branch rejected it.
    expect(waiter.cancelled).toBe(true);

    holder.resolve(['row']);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toEqual(['q0']);
    expect(pressureOf(handle)).toMatchObject({ admitted: 0, waiting: 0 });
  });

  it('gives up on a query whose cancel brings no answer, and keeps its place until one comes', async () => {
    vi.useFakeTimers();
    const { handle, dispatched, unsafe } = gatedPool(1, 100, 50);
    const wedged = unsafe();
    wedged.start();

    // The deadline's cancel went to a pooler that lost the reply; the grace
    // runs out with nothing back. Rejected for the caller, place kept.
    vi.advanceTimersByTime(150);
    expect(wedged.rejectedWith).toMatchObject({
      code: '57014',
      message: expect.stringContaining('no answer') as unknown,
    });
    expect(pressureOf(handle)).toMatchObject({ admitted: 1, lost: 1 });

    // Admitting another in its place would leave postgres.js a connection
    // short of its admitted queries, and pipelining again.
    const next = unsafe();
    next.start();
    expect(dispatched).toEqual(['q0']);

    // The reply comes after all: the connection is free, and so is the place.
    wedged.resolve(['late']);
    await vi.advanceTimersByTimeAsync(0);
    expect(pressureOf(handle)).toMatchObject({ lost: 0 });
    expect(dispatched).toEqual(['q0', 'q1']);
    next.resolve(['row']);
  });

  it('frees a place once however many times postgres.js settles the query', async () => {
    const { handle, unsafe } = gatedPool(1);
    const query = unsafe();
    query.start();

    query.resolve(['row']);
    query.reject(new Error('a late cancel racing the answer'));
    await microtasks();

    expect(pressureOf(handle)).toMatchObject({ admitted: 0 });
  });

  it('holds one place for a transaction, whose own BEGIN does not queue for a second', async () => {
    const dispatched: string[] = [];
    let release: () => void = () => {};
    const handle = {
      unsafe: () => gatedQuery(dispatched, 'statement'),
      // postgres.js's `begin()` issues BEGIN through the pool's own `unsafe`,
      // synchronously, before its first await.
      begin(fn: (client: unknown) => Promise<unknown>) {
        const begin = handle.unsafe();
        begin.start();
        begin.resolve([]);
        return new Promise((resolve) => (release = () => resolve(fn({ unsafe: () => null }))));
      },
    };
    instrumentClient(handle, 1_000, { admit: 1 });

    const transaction = handle.begin(() => Promise.resolve('done'));
    await microtasks();
    // The gate held at one, and BEGIN still went: it did not wait for itself.
    expect(dispatched).toEqual(['statement']);
    expect(pressureOf(handle)).toMatchObject({ admitted: 1 });

    const after = handle.unsafe() as ReturnType<typeof gatedQuery>;
    after.start();
    expect(pressureOf(handle)).toMatchObject({ waiting: 1 });

    release();
    await expect(transaction).resolves.toBe('done');
    await microtasks();
    expect(dispatched).toEqual(['statement', 'statement']);
    after.resolve(null);
  });

  it('refuses a transaction still waiting for a place at its deadline', async () => {
    vi.useFakeTimers();
    const dispatched: string[] = [];
    const handle = {
      unsafe: () => gatedQuery(dispatched, 'statement'),
      begin: () => Promise.resolve('never'),
    };
    instrumentClient(handle, 100, { admit: 1 });

    const holder = handle.unsafe() as ReturnType<typeof gatedQuery>;
    holder.start();
    const transaction = handle.begin();
    const outcome = expect(transaction).rejects.toMatchObject({ code: '57014' });

    vi.advanceTimersByTime(100);
    await outcome;
    holder.resolve(null);
  });

  it('never cancels a query postgres.js holds unsent, and cancels it once it runs', async () => {
    vi.useFakeTimers();
    // The first query of a connection still connecting: handed over, not sent.
    const { handle, unsafe } = gatedPool(1, 100, 5_000, true);
    const query = unsafe();
    query.start();

    // postgres.js's cancel would mark it and leave it in place, and the
    // connection would stay in `connecting` until its max_lifetime.
    vi.advanceTimersByTime(2_500);
    expect(query.cancels).toBe(0);
    expect(pressureOf(handle)).toMatchObject({ admitted: 1, lost: 0 });

    // Connected: it runs, and the next look sends the cancel it was owed.
    query.run();
    vi.advanceTimersByTime(1_000);
    expect(query.cancels).toBe(1);

    query.resolve(['row']);
    await vi.advanceTimersByTimeAsync(0);
    expect(pressureOf(handle)).toMatchObject({ admitted: 0, lost: 0 });
  });

  it('takes a waiter refused at its deadline out of the line at once', () => {
    vi.useFakeTimers();
    const { handle, unsafe } = gatedPool(1, 100);
    const holder = unsafe();
    const waiter = unsafe();
    holder.start();
    waiter.start();
    expect(pressureOf(handle).waiting).toBe(1);

    vi.advanceTimersByTime(100);
    expect(waiter.rejectedWith).toMatchObject({ code: '57014' });
    expect(pressureOf(handle).waiting).toBe(0);
    holder.resolve(null);
  });

  it("keeps a transaction's place for good once its BEGIN went unanswered", async () => {
    vi.useFakeTimers();
    let begin: ReturnType<typeof gatedQuery> | undefined;
    let opening: ((outcome: 'resolved' | 'rejected', value: unknown) => void) | undefined;
    const handle = {
      unsafe: () => gatedQuery([], 'statement', { settled: opening }),
      // postgres.js's begin(): BEGIN through the pool's own `unsafe`,
      // synchronously, then a promise that settles as BEGIN does.
      begin(_fn: (client: unknown) => Promise<unknown>) {
        return new Promise((resolve, reject) => {
          opening = (outcome, value) => (outcome === 'resolved' ? resolve(value) : reject(value));
          begin = handle.unsafe() as ReturnType<typeof gatedQuery>;
          opening = undefined;
          begin.start();
        });
      },
    };
    instrumentClient(handle, 100, { admit: 2, lostAfterMs: 50 });

    const transaction = handle.begin(() => Promise.resolve(null));
    const outcome = expect(transaction).rejects.toMatchObject({ code: '57014' });
    await vi.advanceTimersByTimeAsync(200);
    await outcome;
    expect(begin?.rejectedWith).toMatchObject({ code: '57014' });
    expect(pressureOf(handle)).toMatchObject({ admitted: 1, lost: 1 });

    // A late answer leaves postgres.js's connection reserved with a
    // transaction open and nobody to end it: the place stays taken.
    begin!.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pressureOf(handle)).toMatchObject({ admitted: 1, lost: 1 });
  });

  it('gives up on a transaction whose COMMIT never answers, and takes the place back when it does', async () => {
    vi.useFakeTimers();
    let settleCommit: () => void = () => {};
    const handle = {
      unsafe: () => gatedQuery([], 'statement'),
      // The body runs and finishes; the COMMIT postgres.js then writes on its
      // own, past `unsafe()`, does not answer until the test says.
      begin(fn: (client: unknown) => Promise<unknown>) {
        return Promise.resolve(fn({ unsafe: () => gatedQuery([], 'inner') })).then(
          (value) => new Promise((resolve) => (settleCommit = () => resolve(value))),
        );
      },
    };
    instrumentClient(handle, 100, { admit: 2, lostAfterMs: 50 });

    const transaction = handle.begin(() => Promise.resolve('done'));
    const outcome = expect(transaction).rejects.toMatchObject({ code: '57014' });
    await vi.advanceTimersByTimeAsync(200);
    await outcome;
    expect(pressureOf(handle)).toMatchObject({ admitted: 1, lost: 1 });

    settleCommit();
    await vi.advanceTimersByTimeAsync(0);
    expect(pressureOf(handle)).toMatchObject({ admitted: 0, lost: 0 });
  });

  it('refuses the iterator form of cursor(), which would bypass the gate, and keeps the callback form', () => {
    const cursorCalls: unknown[][] = [];
    const handle = {
      unsafe: () => ({
        ...gatedQuery([], 'cursor'),
        cursor: (...args: unknown[]) => {
          cursorCalls.push(args);
          return 'cursor';
        },
      }),
    };
    instrumentClient(handle, 1_000, { admit: 1 });
    const query = handle.unsafe() as unknown as { cursor: (...args: unknown[]) => unknown };

    expect(() => query.cursor(10)).toThrow(/bypasses the pool gate/);
    expect(query.cursor(10, () => undefined)).toBe('cursor');
    expect(cursorCalls).toHaveLength(1);
  });

  it('names the pool it reports on, beside every other pool in the process', () => {
    getSql();
    const pressure = poolPressure();

    expect(pressure.name).toMatch(/^pool \d+$/);
    expect(pressure.admitMax).toBe(ADMIT_MAX);
    expect(allPoolPressures().map((pool) => pool.name)).toContain(pressure.name);
  });
});
