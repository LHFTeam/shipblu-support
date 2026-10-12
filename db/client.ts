import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env, sessionDatabaseUrl } from '@/lib/env';
import { logger } from '@/lib/log';
import * as schema from './schema';

/**
 * Two connection paths, as designed:
 *
 *  - `db` goes through Supavisor's TRANSACTION pooler. Prepared statements must be
 *    disabled there, because the pooler multiplexes connections and a prepared
 *    statement created on one backend will not exist on the next.
 *  - `sessionSql()` opens a SESSION-mode connection, which is the only way to use
 *    LISTEN. It is opened on demand so the worker and one-shot jobs (which never
 *    listen) do not pay for a connection they will not use.
 *
 * Everything here initialises lazily. `next build` imports route modules to
 * collect page data without runtime secrets present, so opening a pool (or even
 * reading env) at module scope would fail the build.
 *
 * One web process holds **two** pools, not one: Turbopack bundles this module
 * once for route handlers and once for pages, and each copy opens its own on
 * first use (`docs/PROJECT-STATE.md` §5.0). Everything that describes a pool
 * lives on the pool's handle, and `allPoolPressures()` is how one copy reports
 * on the other.
 */

declare global {
  // Next's dev server hot-reloads modules; without this the pool is recreated on
  // every reload and Postgres runs out of connections.
  var __shipbluSql: ReturnType<typeof postgres> | undefined;
  // Every pool this process has opened, by name, for `/api/health`. On
  // `globalThis` because the two bundled copies of this module share nothing
  // else.
  var __shipbluPools: Map<string, PoolState> | undefined;
  var __shipbluPoolCount: number | undefined;
}

const log = logger('db');

export const POOL_MAX = 10;

/**
 * How many queries and transactions the gate lets into postgres.js at once: two
 * fewer than it has connections, so that it never has to pipeline.
 *
 * **postgres.js must never pipeline through the transaction pooler.** When every
 * connection is busy, postgres.js writes the next query onto a connection that
 * is still waiting for an answer, or drains its queue into one write on the next
 * connection to free up. Supavisor's transaction mode (v2.9, which this project
 * is on) hands the backend back to its pool as soon as one read from Postgres
 * ends in ReadyForQuery, so the replies owed for the rest of such a write are
 * dropped or reach another client. The query that lost its reply never settles:
 * postgres.js cannot give up on a query it has sent, and its cancel either goes
 * to a client the pooler thinks is idle or to a backend Postgres will not
 * interrupt while it waits for input. A loss the pooler records as idle takes
 * the connection for the life of the process. That is the 2026-10-11 freeze
 * (§6.91): losses at three pool-ceiling bursts over about twelve hours, until
 * the page pool had no connection left.
 *
 * The gate keeps postgres.js below that point: with at most this many queries
 * inside it, `handler()` always finds an idle or unopened connection and never
 * reaches the busy ones. The two spare connections are for the moments a
 * connection is neither — closing at its `max_lifetime`, or failed and not yet
 * closed — when a gate at `POOL_MAX` would find every usable connection taken
 * and pipeline the next query after all. They are moments because nothing here
 * cancels a query postgres.js has not sent (`track()`): that cancel is what
 * leaves a connection in `connecting` for its whole `max_lifetime`.
 */
export const ADMIT_MAX = POOL_MAX - 2;

/**
 * How long a query may stay unanswered after its deadline before it is given up
 * on and its connection counted as lost.
 *
 * A cancel that reaches a running statement is answered in milliseconds. One
 * still unanswered ten seconds later went to a connection whose reply is not
 * coming — the shape above, or anything else that leaves a backend waiting on
 * us — and waiting longer only holds the request that asked.
 */
const LOST_AFTER_CANCEL_MS = 10_000;

/**
 * In flight at or below this, a latched ceiling warning clears. Half the gate
 * rather than one below the ceiling: with the gate in front, a burst of
 * waiting queries is normal, and a latch that cleared at the first query out
 * logged a pair of lines per render.
 */
const CLEARS_AT = Math.floor(ADMIT_MAX / 2);

/** How often a cancel waits to be safe to send: see `abandon` in `track()`. */
const RECHECK_CANCEL_MS = 1_000;

/**
 * One pool's numbers and its gate, kept on the pool's handle.
 *
 * On the handle rather than in this module, so a dev hot reload that adopts the
 * pool off `globalThis` adopts these with it, and so would a second bundled copy
 * if production ever shared one pool: two gates in front of one pool would each
 * admit their full quota, and counters split across copies would each read low.
 */
type PoolState = {
  /** `pool 1`, `pool 2`: set when `getSql()` registers the pool. */
  name: string | null;
  /**
   * Queries in flight or waiting for a place.
   *
   * postgres.js keeps no such number and exposes none: its `queues` object and
   * its pending-query list are closure-locals that never reach the `sql`
   * handle. That absence is why the 2026-09-08 freeze left one misattributed
   * `Failed query` line as its entire app-side evidence (§62), so the counter
   * exists to be reported rather than because anything branches on it.
   */
  inFlight: number;
  peak: number;
  /**
   * When the peak happened. A high-water mark with no clock beside it cannot
   * distinguish pressure now from pressure an hour ago: one transient spike
   * pins `peak` at the ceiling for the life of the instance.
   */
  peakAt: string | null;
  /**
   * Transactions currently open. Counted separately because a transaction
   * *reserves* a connection for its whole lifetime rather than queueing for
   * one — so `inFlight` alone can read zero while every slot is held.
   */
  transactions: number;
  /** Latched by the ceiling warning in `track()`, so saturation is one line. */
  atCeiling: boolean;
  gate: Gate | null;
};

/**
 * One pool's admission gate: `limit` places, and a line for the rest.
 */
type Gate = {
  limit: number;
  /** Queries and transactions holding a place, lost ones included. */
  admitted: number;
  /** Of `admitted`, those given up on whose reply has not come. */
  lost: number;
  /**
   * The line, oldest first from `head`. A waiter that leaves is marked rather
   * than spliced out, and `pump` steps over it: in the burst the gate exists
   * for, hundreds of waiters reach their deadline together, and taking each
   * out of an array would drain the line in quadratic time on the request
   * thread.
   */
  queue: Waiter[];
  head: number;
  /** Waiters still in the line. */
  waiting: number;
};

/**
 * A place in the line. `start` returns whether it used the place it was given;
 * `done` is set once it has been given one or has left.
 */
type Waiter = { start: () => boolean; done: boolean };

export type PoolPressure = {
  /** `pool 1`, `pool 2`: which of the process's pools, in the order they opened. */
  name: string | null;
  inFlight: number;
  transactions: number;
  peak: number;
  peakAt: string | null;
  max: number;
  /** Queries and transactions inside postgres.js, out of `admitMax`. */
  admitted: number;
  /** Waiting at the gate for one of those places. */
  waiting: number;
  /** Admitted work given up on whose reply has not come; their connections are held. */
  lost: number;
  admitMax: number;
};

const STATE = Symbol.for('shipblu.db.state');
const INSTRUMENTED = Symbol.for('shipblu.db.instrumented');

type Marked = {
  [STATE]?: PoolState;
  [INSTRUMENTED]?: true;
};

function stateOf(handle: object): PoolState | null {
  return (handle as Marked)[STATE] ?? null;
}

function pressure(state: PoolState | null): PoolPressure {
  return {
    name: state?.name ?? null,
    inFlight: state?.inFlight ?? 0,
    transactions: state?.transactions ?? 0,
    peak: state?.peak ?? 0,
    peakAt: state?.peakAt ?? null,
    max: POOL_MAX,
    admitted: state?.gate?.admitted ?? 0,
    waiting: state?.gate?.waiting ?? 0,
    lost: state?.gate?.lost ?? 0,
    admitMax: state?.gate?.limit ?? ADMIT_MAX,
  };
}

/**
 * Every pool in this process, the other bundled copy's included, for
 * `/api/health`.
 *
 * One copy of this module sees only the pool it opened — for `/api/health`
 * the route handlers' — while the pool that froze on 2026-09-08 and again on
 * 2026-10-11 was the one pages use.
 */
export function allPoolPressures(): PoolPressure[] {
  return [...(globalThis.__shipbluPools?.values() ?? [])].map(pressure);
}

/** One instrumented handle's numbers, for the tests that drive a pool of their own. */
export function pressureOf(handle: object): PoolPressure {
  return pressure(stateOf(handle));
}

/**
 * The members of a postgres.js query this module reaches: the completion hooks
 * postgres.js calls, the dispatch it calls to hand the query to the pool, the
 * cancel primitive, and the fields that say where the query is. They are
 * instance properties assigned in its `Query` constructor and its connection,
 * not part of its public types, so `track()` declares the shape it wraps and
 * `db/client.test.ts` asserts the wrapping still takes effect — a library
 * upgrade that renamed one would otherwise silently stop bounding anything.
 */
type Settleable = {
  resolve: (value: unknown) => unknown;
  reject: (error: unknown) => unknown;
  /**
   * The cancel primitive itself, rather than the `cancel()` method that calls
   * it. `cancelQuietly()` below says why the method cannot be used.
   */
  canceller: ((query: unknown) => unknown) | null;
  /** Hands the query to the pool. Called once, from the query's `handle()`. */
  handler?: (query: unknown) => unknown;
  /**
   * Set by postgres.js's cancel on a query not yet running: `true` for one it
   * has not sent, a resolver pair for one sent behind another.
   */
  cancelled?: unknown;
  /** The connection's backend key, set when the query is written to it; null before. */
  state?: unknown;
  /** True while the query is the one its connection is answering. */
  active?: boolean;
  /** Present on a real query; see `track()` for why its iterator form is refused. */
  cursor?: (...args: unknown[]) => unknown;
};

/**
 * `query.cancel()`, minus the unhandled rejection.
 *
 * postgres.js's method is `this.canceller && (this.canceller(this),
 * this.canceller = null)`, and the comma operator throws away the promise the
 * canceller returns. For a query already on the wire that promise is a *new*
 * TCP connection carrying a protocol CancelRequest, and it rejects through
 * `socket.once('error', reject)` when that connection is refused or reset —
 * which is what a saturated pooler does to a new connection. Nothing would be
 * listening to it, and Node 22 exits the process on an unhandled rejection: the
 * worker and the job runner both run under plain `tsx` with no handler of their
 * own, so the mitigation would crash-loop them on precisely the condition this
 * timer fires against.
 *
 * So the canceller is called directly, its promise is given a handler, and it is
 * nulled exactly as `cancel()` does so a second call is a no-op. A cancel that
 * could not be delivered needs no log line of its own: the query rejects either
 * way, and that rejection is what the caller sees.
 */
function cancelQuietly(query: Settleable): void {
  const { canceller } = query;
  if (!canceller) return;

  query.canceller = null;
  void Promise.resolve(canceller.call(query, query)).catch(() => {
    /* the CancelRequest could not be delivered; the query still rejects */
  });
}

// --- The gate ---------------------------------------------------------------

/** Joins the line; null when a place was free and `start` has already run. */
function admit(gate: Gate, start: () => boolean): Waiter | null {
  const waiter = { start, done: false };
  gate.queue.push(waiter);
  gate.waiting += 1;
  pump(gate);
  return waiter.done ? null : waiter;
}

/** Takes a waiter out of the line: one refused at its deadline holds nothing. */
function leave(gate: Gate, waiter: Waiter): void {
  if (waiter.done) return;
  waiter.done = true;
  gate.waiting -= 1;
  // An empty line lets go of the waiters it was stepping over, and the
  // queries they hold, rather than at the next burst.
  if (gate.waiting === 0) {
    gate.queue.length = 0;
    gate.head = 0;
  }
}

function pump(gate: Gate): void {
  while (gate.admitted < gate.limit && gate.head < gate.queue.length) {
    const waiter = gate.queue[gate.head]!;
    gate.head += 1;
    if (waiter.done) continue;
    waiter.done = true;
    gate.waiting -= 1;
    gate.admitted += 1;
    if (!waiter.start()) gate.admitted -= 1;
  }
  // Dropped in one go once the walked part is most of the array, so the cost
  // is spread over the waiters it passed.
  if (gate.head === gate.queue.length || gate.head > gate.queue.length / 2) {
    gate.queue.splice(0, gate.head);
    gate.head = 0;
  }
}

/**
 * Gives a place back, on the next microtask rather than now.
 *
 * postgres.js settles a query inside its ReadyForQuery handler and only then
 * moves the connection back to `open`. Admitting the next query synchronously
 * from here would find that connection still taken — and, with every other one
 * busy, write the query onto a busy connection: the pipelining the gate exists
 * to prevent. By the next microtask the handler has returned.
 */
function release(gate: Gate): void {
  queueMicrotask(() => {
    gate.admitted -= 1;
    pump(gate);
  });
}

/** `(pool 2: 6 running, 3 waiting, 0 lost of 8)`, or less where there is less to say. */
function describe(state: PoolState): string {
  const name = state.name ?? 'pool';
  const gate = state.gate;
  if (!gate) return ` (${name})`;
  return ` (${name}: ${gate.admitted - gate.lost} running, ${gate.waiting} waiting, ${gate.lost} lost of ${gate.limit})`;
}

function canceled(message = 'canceling statement due to user request'): Error {
  // `query_canceled`, as every other way a query ends here is: to a caller it
  // is a statement that was cancelled, whatever happened to the reply.
  return Object.assign(new Error(message), { code: '57014' });
}

// --- Tracking one query -----------------------------------------------------

type TrackOptions = {
  state: PoolState;
  /** Null for no deadline: the caller bounds it, as the health probes do. */
  timeoutMs: number | null;
  /** How long after its deadline the query is given up on. */
  lostAfterMs: number;
  /** The pool's gate, for a query that reaches the pool rather than a transaction. */
  gate: Gate | null;
  /** The transaction the query runs in, which holds the place at the gate for it. */
  txn?: TransactionWatch;
};

/**
 * What a statement tells the transaction it runs in, which holds the gate's
 * place on its behalf.
 */
type TransactionWatch = {
  /**
   * A statement was given up on: its connection is waiting for a reply. The
   * caller is told now, since the statement has failed as far as the body can
   * see, and the body's failure is a ROLLBACK.
   */
  lost: (error: Error) => void;
  /**
   * Something postgres.js wrote on its own has gone unanswered: the place is
   * counted lost, but the caller is not told, because nothing failed that it
   * could act on (`clock`).
   */
  held: () => void;
  /**
   * The answer to what was given up on or held came after all — `resolved` or
   * `rejected` by postgres.js, which a lost BEGIN needs to know.
   */
  recovered: (outcome: Outcome) => void;
  /**
   * Starts a clock on a statement postgres.js writes itself — `COMMIT`,
   * `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO` — which never pass `unsafe()` and so
   * carry no deadline. Cleared when what waits on it settles.
   */
  stall: (label: string) => Clock;
};

type Outcome = 'resolved' | 'rejected';

type Clock = { clear: () => void };

/** What `track()` hands back besides the query. */
type Tracked = {
  /** Cancels the query where that is safe, and gives up on it if no answer comes. */
  abandon: () => void;
};

/**
 * Counts one query from creation to settle, gives it a deadline, and — for a
 * query on the pool — holds it at the gate until postgres.js has a connection
 * free for it.
 *
 * The deadline exists because the pool's queue has none. postgres.js parks a
 * query beyond `max` in an unbounded, untimed array and returns a promise that
 * settles when a slot frees and **never rejects**. So a saturated pool does not
 * fail — it stops answering, Postgres logs nothing because nothing arrives, and
 * the CPU idles. That is how the 2026-09-08 outage looked: requests queued from
 * 20 seconds to 40 minutes behind ten busy slots while every external signal
 * said the database was healthy. With the gate in front, the queue that fills
 * is the gate's, and a query waiting there is one the cancel removes and
 * rejects with `57014` — postgres.js's own branch for a query it has not sent.
 *
 * Only two kinds of query are cancelled through postgres.js: one still waiting
 * at the gate, and one its connection is running. A query postgres.js holds but
 * is not running — the first query of a connection still connecting, or a
 * statement queued or pipelined behind another inside a transaction — is left
 * alone, and asked about again every `RECHECK_CANCEL_MS`. postgres.js's cancel
 * would mark it and leave it where it is, and a marked query moves nothing on
 * when its turn comes: the connection stays in `connecting` until its
 * `max_lifetime`, or the transaction's queue stops behind it with its
 * `ROLLBACK`, and a marked query pipelined behind another hands its reply to
 * the query after it.
 *
 * For a query running, the cancel opens a *separate* socket to send a protocol
 * CancelRequest, which is what makes it work at all when the pool is the thing
 * that is exhausted. It goes through `cancelQuietly()` rather than the
 * library's own `cancel()`, for the reason stated there. If no answer comes
 * `lostAfterMs` after the deadline, the query is rejected here instead and its
 * place at the gate is kept: the connection it sits on is still waiting for a
 * reply, so admitting another query in its place would leave postgres.js one
 * connection short and pipelining again. The place comes back if the reply ever
 * does.
 *
 * Three things this deliberately does not do. It does not call `.then()` on the
 * query: that would run postgres.js's `handle()` and dispatch immediately,
 * racing the `.values()` that drizzle chains on the next expression — the flag
 * lands in time today only because `handle()` defers by a microtask, which is
 * far too fine a thread to hang this on. It does not set
 * `connection: { statement_timeout }`: that is a one-shot StartupMessage
 * parameter, and on Supavisor's transaction pooler nothing guarantees it reaches
 * the backend our statement actually runs on. And it does not set
 * `max_pipeline: 0`, which would stop the pipelining without a gate: postgres.js
 * then never calls the hook `begin()` uses to find its connection, and every
 * transaction fails with `UNSAFE_TRANSACTION`.
 *
 * The iterator form of `.cursor()` is refused: it replaces the query's
 * `resolve` and `reject` on every step, so the hooks below would never run and
 * its place would never come back. Nothing uses it; the callback form, which
 * keeps them, still works. `.describe()` and COPY settle before their
 * connection is free and are not used either.
 */
function track<T>(query: T, options: TrackOptions): Tracked {
  const settleable = query as T & Settleable;
  const { state, gate, timeoutMs, lostAfterMs, txn } = options;

  state.inFlight += 1;
  if (state.inFlight > state.peak) {
    state.peak = state.inFlight;
    state.peakAt = new Date().toISOString();
  }

  // Latched on the way up rather than tested on every query. As a level test
  // this logged once per `client.unsafe()` for as long as the pressure lasted —
  // thousands of identical lines over the fifty minutes of §62, pushing the one
  // useful signal out of Render's retention, which is the opposite of what it
  // is for. Re-armed on the way down, so a saturation event is one line and its
  // recovery is another.
  if (state.inFlight >= POOL_MAX && !state.atCeiling) {
    state.atCeiling = true;
    log.warn(`${state.inFlight} queries in flight against max ${POOL_MAX}${describe(state)}`);
  }

  /** Our accounting has run: the caller has its answer or its error. */
  let settled = false;
  /** Handed to postgres.js: past the gate, or straight in for a statement in a transaction. */
  let dispatched = false;
  /** Holding a place at the gate. */
  let admitted = false;
  /** Given up on, with its place kept. */
  let lost = false;
  let answeredOnce = false;
  let waiter: Waiter | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineTimer);
    clearTimeout(recheckTimer);
    clearTimeout(lostTimer);
    if (waiter && gate) leave(gate, waiter);
    waiter = null;
    state.inFlight -= 1;
    if (state.atCeiling && state.inFlight <= CLEARS_AT) {
      state.atCeiling = false;
      log.warn(`pool pressure cleared, ${state.inFlight} in flight${describe(state)}`);
    }
  };

  /**
   * postgres.js has answered: the one thing that proves the connection is free
   * again. Once only, because postgres.js can settle a query twice — a late
   * reply to a query already rejected here, or its own cancel racing an answer.
   */
  const answered = (outcome: Outcome) => {
    if (answeredOnce) return;
    answeredOnce = true;
    if (lost) txn?.recovered(outcome);
    if (!admitted || !gate) return;
    admitted = false;
    if (lost) {
      gate.lost -= 1;
      log.warn(`a lost connection answered after all${describe(state)}`);
    }
    release(gate);
  };

  const { resolve, reject } = settleable;
  settleable.resolve = (value) => (answered('resolved'), finish(), resolve.call(settleable, value));
  settleable.reject = (error) => (answered('rejected'), finish(), reject.call(settleable, error));

  const giveUp = () => {
    if (settled) return;
    lost = true;
    if (admitted && gate) gate.lost += 1;
    log.warn(`a query had no answer ${lostAfterMs}ms after its deadline${describe(state)}`);
    finish();
    const error = canceled(
      `query had no answer ${lostAfterMs}ms after its deadline; its connection is treated as lost`,
    );
    // The library's own reject, not the wrapper: the wrapper would give the
    // place back as though the connection had answered.
    reject.call(settleable, error);
    txn?.lost(error);
  };

  const abandon = () => {
    if (settled) return;
    // Held by postgres.js but not running: unsent, or pipelined behind another.
    // A query still at the gate is neither, and its cancel is the clean one.
    if (!settleable.active && (dispatched || settleable.state != null)) {
      // Inside a transaction a statement given up on unsent is rolled back
      // with the rest of it. On the pool one would still be sent once a
      // connection took it — an autocommit write its caller was told had
      // failed — so the clock to give up on it starts only once it is sent.
      if (txn) lostTimer ??= setTimeout(giveUp, lostAfterMs);
      recheckTimer = setTimeout(abandon, RECHECK_CANCEL_MS);
      return;
    }
    lostTimer ??= setTimeout(giveUp, lostAfterMs);
    cancelQuietly(settleable);
  };

  if (timeoutMs !== null) deadlineTimer = setTimeout(abandon, timeoutMs);

  if (typeof settleable.handler === 'function') {
    const dispatch = settleable.handler;
    settleable.handler = (self) => {
      if (!gate) {
        dispatched = true;
        return dispatch.call(settleable, self);
      }
      waiter = admit(gate, () => {
        waiter = null;
        // Cancelled, or given up on, while it waited: nothing to send.
        if (settled || settleable.cancelled) return false;
        admitted = true;
        dispatched = true;
        dispatch.call(settleable, self);
        return true;
      });
    };
  }

  if (typeof settleable.cursor === 'function') {
    const cursor = settleable.cursor;
    settleable.cursor = (...args: unknown[]) => {
      if (typeof args[0] !== 'function' && typeof args[1] !== 'function') {
        throw new Error(
          'the iterator form of cursor() bypasses the pool gate in db/client.ts; pass a callback',
        );
      }
      return cursor.apply(settleable, args);
    };
  }

  return { abandon };
}

/** The four members of a postgres.js handle this needs to reach. */
type Instrumentable = {
  unsafe: (...args: unknown[]) => unknown;
  begin?: (...args: unknown[]) => unknown;
  savepoint?: (...args: unknown[]) => unknown;
};

/**
 * Set while postgres.js's `begin()` runs its synchronous prefix, during which it
 * issues its own `BEGIN` through the pool's `unsafe()`. That statement opens the
 * transaction the gate has already admitted, so it must not queue for a second
 * place — with the gate full it would wait for itself — and it reports to the
 * transaction rather than to the gate.
 */
let beginning: Opening | null = null;

/** What a transaction knows about its own `BEGIN`. */
type Opening = {
  txn: TransactionWatch | undefined;
  /**
   * The connection postgres.js reserved for the transaction, caught from the
   * `onexecute` hook its `begin()` hands the `BEGIN`: the one way to end a
   * transaction whose `BEGIN` answered after it was given up on.
   */
  connection?: { terminate: () => void };
};

export type InstrumentOptions = {
  /** Put the handle's queries and transactions behind an admission gate of this size. */
  admit?: number;
  /** How long after its deadline a query is given up on; `LOST_AFTER_CANCEL_MS` unless a test says. */
  lostAfterMs?: number;
};

/** The two clocks every tracked query runs on. */
type Limits = { timeoutMs: number; lostAfterMs: number };

/**
 * Installs the deadline, and optionally the gate, on one postgres.js handle,
 * once.
 *
 * `unsafe` is an **own property of each handle** rather than something
 * inherited: the library's `Sql(handler)` factory declares its own `unsafe`
 * closure and `Object.assign`s it onto the handle it returns. That is what makes
 * patching a handle possible at all — and what makes patching the pool alone
 * insufficient, because a transaction body is handed a *fresh* handle:
 * `begin()` calls `scope()`, which calls `Sql(handler)` again, and drizzle then
 * runs every statement of the transaction through that handle's `unsafe`.
 *
 * Leaving that half out would have left ~20 call sites unbounded, the three
 * five-minute sweeps among them, and it is the worse half: a transaction
 * *reserves* one of the `POOL_MAX` connections for its whole lifetime, so one
 * that never finishes takes a slot with it rather than queueing behind one.
 * `savepoint` is wrapped for the same reason, one level further in.
 *
 * The gate goes on the pool's handle only. A transaction holds one place from
 * before its `BEGIN` until it settles, and its statements run on the connection
 * it reserved, which is not the pool's to give out: postgres.js may pipeline
 * them there, and inside an explicit transaction that is safe, because Postgres
 * reports the transaction open on every ReadyForQuery until the `COMMIT`, and
 * the pooler keeps the backend until it reports it closed.
 *
 * The handle is marked rather than remembered here, because `getSql()` adopts
 * the pool off `globalThis` across a dev hot reload: a re-run module scope
 * would otherwise wrap the previous scope's wrapper, and every query would arm
 * N timers against N counters behind N gates.
 *
 * Exported for `db/client.test.ts`, in the same spirit as `interactionWindowSet`
 * — the wrapping is the whole mechanism and there is no other way to reach it
 * without a live connection.
 */
export function instrumentClient<T>(
  client: T,
  timeoutMs: number,
  options: InstrumentOptions = {},
): T {
  const marked = client as unknown as Marked;
  marked[STATE] ??= {
    name: null,
    inFlight: 0,
    peak: 0,
    peakAt: null,
    transactions: 0,
    atCeiling: false,
    gate: options.admit
      ? { limit: options.admit, admitted: 0, lost: 0, queue: [], head: 0, waiting: 0 }
      : null,
  };
  const limits = { timeoutMs, lostAfterMs: options.lostAfterMs ?? LOST_AFTER_CANCEL_MS };
  return instrumentWith(client, limits, marked[STATE]);
}

function instrumentWith<T>(client: T, limits: Limits, state: PoolState, txn?: TransactionWatch): T {
  const handle = client as unknown as Instrumentable & Marked;
  if (handle[INSTRUMENTED]) return client;
  handle[INSTRUMENTED] = true;
  // Statements in a transaction run on its own connection, past the gate.
  const gate = txn ? null : state.gate;

  const native = handle.unsafe.bind(handle);
  handle.unsafe = (...args: unknown[]) => {
    const opening = beginning;
    if (opening) catchConnection(args, opening);
    const query = native(...args);
    track(
      query,
      opening
        ? { ...limits, state, gate: null, txn: opening.txn }
        : { ...limits, state, gate, txn },
    );
    return query;
  };

  const nativeBegin = handle.begin;
  if (nativeBegin) {
    handle.begin = (...args: unknown[]) =>
      beginBehind(state, gate, limits, nativeBegin, handle, args);
  }

  const nativeSavepoint = handle.savepoint;
  if (nativeSavepoint) {
    handle.savepoint = (...args: unknown[]) => {
      // `SAVEPOINT` goes out before the body runs and `ROLLBACK TO` after it
      // fails, both written by postgres.js itself: each gets a clock of its own.
      const opening = txn?.stall('SAVEPOINT');
      let closing: Clock | undefined;
      const scoped = instrumentScope(args, limits, state, false, txn, {
        started: () => opening?.clear(),
        finished: () => {
          closing = txn?.stall('ROLLBACK TO SAVEPOINT');
        },
      });
      return Promise.resolve(nativeSavepoint.apply(handle, scoped)).finally(() => {
        opening?.clear();
        closing?.clear();
      });
    };
  }

  return client;
}

/**
 * Wraps the `onexecute` option postgres.js's `begin()` passes with its `BEGIN`
 * — `sql.unsafe('begin', [], { onexecute })` — so the transaction learns which
 * connection it reserved.
 */
function catchConnection(args: unknown[], opening: Opening): void {
  const options = args[2] as { onexecute?: (connection: unknown) => unknown } | undefined;
  const onexecute = options?.onexecute;
  if (!options || typeof onexecute !== 'function') return;
  options.onexecute = (connection) => {
    opening.connection = connection as Opening['connection'];
    return onexecute(connection);
  };
}

/**
 * A clock on a statement postgres.js writes itself. Firing counts the
 * transaction's place lost and says so; it does not reject the caller.
 *
 * Nothing here can cancel or inspect a `COMMIT` in flight, so one that is
 * only slow — a large write's fsync, a deferred constraint — may still commit
 * after any deadline. Rejecting then would turn "not known yet" into
 * "failed": the action reports an error for a write that happened, and a
 * retry writes it twice. So the caller waits for the real outcome, as it did
 * before the gate, and the place is counted lost meanwhile, which is what
 * `/api/health` and the log need to see a connection that stopped answering.
 */
function clock(state: PoolState, txn: TransactionWatch, label: string, afterMs: number): Clock {
  let fired = false;
  let cleared = false;
  const timer = setTimeout(() => {
    fired = true;
    log.warn(
      `a transaction's ${label} has had no answer in ${afterMs}ms; still waiting for it${describe(state)}`,
    );
    txn.held();
  }, afterMs);
  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      if (fired) txn.recovered('resolved');
    },
  };
}

/**
 * `begin()`, holding one place at the gate for the transaction's whole life.
 *
 * A transaction still waiting at the gate after `timeoutMs` is refused with
 * `57014`, as a waiting query is. One whose statement is given up on is
 * rejected then, rather than when postgres.js's own `ROLLBACK` comes back:
 * that is written onto the same connection behind the statement that never
 * answered, so it never does. The `COMMIT` or `ROLLBACK` postgres.js writes
 * after the body, which no deadline covers, gets a clock that counts the place
 * lost without rejecting anybody (`clock` says why).
 *
 * The place itself is kept, and counted lost, until postgres.js has settled the
 * transaction *and* every statement given up on has been answered: either
 * alone is not proof the connection is free. A `BEGIN` given up on is the one
 * statement whose late answer is not enough. postgres.js reserves the
 * connection when it writes `BEGIN`, and its own `begin()` has already failed,
 * so a late success leaves that connection reserved with a transaction open
 * and nobody to end it. The connection is closed then, which ends the
 * transaction at the server and returns the connection to postgres.js as one
 * to reopen, and only then is the place given back. A late failure is a
 * connection that closed by itself.
 */
function beginBehind(
  state: PoolState,
  gate: Gate | null,
  limits: Limits,
  nativeBegin: (...args: unknown[]) => unknown,
  handle: object,
  args: unknown[],
): Promise<unknown> {
  const start = (txn?: TransactionWatch, opening?: Opening, finished?: () => void) => {
    beginning = opening ?? { txn: undefined };
    try {
      return Promise.resolve(
        nativeBegin.apply(
          handle,
          instrumentScope(args, limits, state, true, txn, { started: () => {}, finished }),
        ),
      );
    } finally {
      beginning = null;
    }
  };

  if (!gate) return start();

  return new Promise((resolve, reject) => {
    let settled = false;
    let waiter: Waiter | null = null;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      if (waiter) leave(gate, waiter);
      finish();
    };

    const waitTimer = setTimeout(() => settle(() => reject(canceled())), limits.timeoutMs);

    waiter = admit(gate, () => {
      waiter = null;
      if (settled) return false;
      clearTimeout(waitTimer);

      /** Statements and clocks given up on whose answer has not come. */
      let unanswered = 0;
      let countedLost = false;
      let nativeSettled = false;
      let released = false;
      let tail: Clock | undefined;

      const releaseWhenFree = () => {
        if (released || !nativeSettled || unanswered > 0) return;
        released = true;
        if (countedLost) {
          gate.lost -= 1;
          log.warn(`a lost transaction connection answered after all${describe(state)}`);
        }
        release(gate);
      };

      const hold = () => {
        unanswered += 1;
        if (!countedLost) {
          countedLost = true;
          gate.lost += 1;
        }
      };

      const txn: TransactionWatch = {
        lost: (error) => {
          hold();
          settle(() => reject(error));
        },
        held: hold,
        recovered: () => {
          unanswered -= 1;
          releaseWhenFree();
        },
        stall: (label) => clock(state, txn, label, limits.timeoutMs + limits.lostAfterMs),
      };

      // The BEGIN reports here, and its late success needs its connection closed.
      const opening: Opening = {
        txn: {
          ...txn,
          lost: (error) => {
            log.warn(`a transaction's BEGIN had no answer${describe(state)}`);
            txn.lost(error);
          },
          recovered: (outcome) => {
            if (outcome === 'resolved') {
              const connection = opening.connection;
              // No connection caught means none was reserved: nothing to close,
              // and no proof the place is free either.
              if (!connection) return;
              log.warn(
                `a transaction's BEGIN answered after it was given up on; closing its connection${describe(state)}`,
              );
              // After the ReadyForQuery being handled now, not inside it.
              queueMicrotask(() => connection.terminate());
            }
            txn.recovered(outcome);
          },
        },
      };

      start(txn, opening, () => {
        tail = txn.stall('COMMIT or ROLLBACK');
      })
        .then(
          (value) => settle(() => resolve(value)),
          (error: unknown) => settle(() => reject(error)),
        )
        .finally(() => {
          nativeSettled = true;
          tail?.clear();
          releaseWhenFree();
        });
      return true;
    });
  });
}

/**
 * Rewrites a `begin`/`savepoint` argument list so the scoped handle its body is
 * called with is instrumented too. Both take the body as their last argument,
 * with an optional name or option string before it.
 *
 * `counts` is true only for `begin`, so a savepoint inside a transaction does
 * not count as a second open transaction. `hooks` say when the body starts and
 * when it is done, which is when postgres.js writes the statements of its own
 * that bracket it.
 */
function instrumentScope(
  args: unknown[],
  limits: Limits,
  state: PoolState,
  counts: boolean,
  txn: TransactionWatch | undefined,
  hooks: { started: () => void; finished?: () => void },
): unknown[] {
  const last = args.length - 1;
  const body = args[last];
  if (typeof body !== 'function') return args;

  const run = body as (client: unknown) => unknown;
  const wrapped = async (client: unknown) => {
    hooks.started();
    if (counts) state.transactions += 1;
    try {
      const result = run(instrumentWith(client, limits, state, txn));
      // postgres.js runs an array of queries a body returns (`scope()`'s
      // `Array.isArray(x) ? Promise.all(x) : x`), and cannot see one through
      // this async function: it would COMMIT with none of them sent.
      return await (Array.isArray(result) ? Promise.all(result) : result);
    } finally {
      if (counts) state.transactions -= 1;
      hooks.finished?.();
    }
  };

  return args.map((arg, index) => (index === last ? wrapped : arg));
}

let pool: ReturnType<typeof postgres> | undefined;

export function getSql(): ReturnType<typeof postgres> {
  if (pool) return pool;

  pool =
    globalThis.__shipbluSql ??
    postgres(env().DATABASE_URL, {
      prepare: false,
      max: POOL_MAX,
      idle_timeout: 20,
      connect_timeout: 10,
    });

  // Every drizzle query reaches the driver as `client.unsafe(text, params)` —
  // the one chokepoint where a deadline and the gate can be attached without
  // touching call sites, and without wrapping the returned query in something
  // that would lose `.values()`.
  instrumentClient(pool, env().DB_QUERY_TIMEOUT_MS, { admit: ADMIT_MAX });

  // Named once per pool, on the pool: a dev reload, or a second copy adopting
  // the same pool, finds the name and the entry already there.
  const state = stateOf(pool)!;
  if (!state.name) {
    globalThis.__shipbluPoolCount = (globalThis.__shipbluPoolCount ?? 0) + 1;
    state.name = `pool ${globalThis.__shipbluPoolCount}`;
  }
  globalThis.__shipbluPools ??= new Map();
  globalThis.__shipbluPools.set(state.name, state);

  if (env().NODE_ENV !== 'production') globalThis.__shipbluSql = pool;
  return pool;
}

type Db = PostgresJsDatabase<typeof schema>;

let instance: Db | undefined;

function getDb(): Db {
  if (!instance) instance = drizzle(getSql(), { schema });
  return instance;
}

/**
 * Proxy so call sites can keep importing `db` directly while the underlying
 * connection is still created on first use rather than on import.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, property) {
    const target = getDb();
    const value = Reflect.get(target, property) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/**
 * `select 1`, in a form `/api/health` can abandon.
 *
 * Raced against a timer there, and the cancel is the reason this exists rather
 * than a plain `db.execute`: losing a race does nothing to the query, which
 * keeps its place in the queue for the whole `DB_QUERY_TIMEOUT_MS`. Render polls
 * the health endpoint far more often than that, so an endpoint that only raced
 * would add a queued query per poll to the saturation it exists to report on.
 *
 * A tagged template rather than `unsafe`, so it carries no deadline of its own —
 * the caller's is shorter and is the one that should apply. It still queues at
 * the gate: a tagged template reaches postgres.js without passing `unsafe`, and
 * a probe let past the gate every five seconds is a query pipelined onto a busy
 * connection whenever the pool is full. And its abandon is `track()`'s, so a
 * probe whose connection is still connecting is waited for rather than
 * cancelled: that cancel would leave the connection in `connecting` until its
 * `max_lifetime`, and five of them would take the gate's spares.
 */
export function databaseProbe(): { done: Promise<unknown>; abandon: () => void } {
  const sql = getSql();
  const state = stateOf(sql)!;
  const query = sql`select 1`;
  const { abandon } = track(query, {
    state,
    timeoutMs: null,
    lostAfterMs: LOST_AFTER_CANCEL_MS,
    gate: state.gate,
  });
  return { done: query as unknown as Promise<unknown>, abandon };
}

/**
 * A dedicated session-mode connection for LISTEN. Callers own the lifetime and
 * must close it. `max: 1` because a listener only ever needs one backend.
 */
export function sessionSql() {
  return postgres(sessionDatabaseUrl(), {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
  });
}

/**
 * Closes the pool if one was ever opened. Used by the worker and job runner.
 *
 * The timeout is not tidiness. A bare `end()` sets the flag that refuses *new*
 * queries but never rejects the ones already queued, and its own close path will
 * hand a freed connection to the next one in the queue — so shutting down with a
 * backlog waits for the backlog. Passing a timeout is what arms the destroy that
 * rejects them, which is the difference between a worker that exits on SIGTERM
 * and one Render eventually kills. Queries still waiting at the gate are
 * refused by postgres.js as they reach it, since the pool is ending.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    const name = stateOf(pool)?.name;
    if (name) globalThis.__shipbluPools?.delete(name);
    await pool.end({ timeout: 5 });
    pool = undefined;
    globalThis.__shipbluSql = undefined;
  }
}
