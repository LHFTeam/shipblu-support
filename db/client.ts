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
 * first use (`docs/PROJECT-STATE.md` §5.0). Everything below is per pool, and
 * `allPoolPressures()` is how one copy reports on the other.
 */

declare global {
  // Next's dev server hot-reloads modules; without this the pool is recreated on
  // every reload and Postgres runs out of connections.
  var __shipbluSql: ReturnType<typeof postgres> | undefined;
  // Every pool this process has opened, by name, for `/api/health`. On
  // `globalThis` because the two bundled copies of this module share nothing
  // else.
  var __shipbluPools: Map<string, () => PoolPressure> | undefined;
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
 * postgres.js cannot give up on a query it has sent, its cancel either goes to a
 * client the pooler thinks is idle or to a backend Postgres will not interrupt
 * while it waits for input. Each loss takes a connection for the life of the
 * process. That is the 2026-10-11 freeze (§6.91): losses at three pool-ceiling
 * bursts over 36 hours, until no connection was left.
 *
 * The gate keeps postgres.js below that point: with at most this many queries
 * inside it, `handler()` always finds an idle or unopened connection and never
 * reaches the busy ones. The two spare connections are for the moments a
 * connection is neither — closing at its `max_lifetime`, or still connecting
 * after the query it opened for was cancelled — when a gate at `POOL_MAX` would
 * find every usable connection taken and pipeline the next query after all.
 */
export const ADMIT_MAX = POOL_MAX - 2;

/**
 * How long a query may stay unanswered after its cancel before it is given up
 * on and its connection counted as lost.
 *
 * A cancel that reaches a running statement is answered in milliseconds. One
 * still unanswered ten seconds later went to a connection whose reply is not
 * coming — the shape above, or anything else that leaves a backend waiting on
 * us — and waiting longer only holds the request that asked.
 */
const LOST_AFTER_CANCEL_MS = 10_000;

/**
 * Queries in flight or waiting for a slot, for this pool.
 *
 * postgres.js keeps no such number and exposes none: its `queues` object and its
 * pending-query list are closure-locals that never reach the `sql` handle. That
 * absence is why the 2026-09-08 freeze left one misattributed `Failed query`
 * line as its entire app-side evidence (§62), so the counter exists to be
 * reported rather than because anything branches on it.
 */
let inFlight = 0;
let peakInFlight = 0;
/**
 * When the peak happened.
 *
 * A high-water mark with no clock beside it cannot distinguish pressure now
 * from pressure an hour ago: one transient spike pins `peak` at the ceiling for
 * the life of the instance, and the number stops being attributable to the
 * measurement anybody is taking with it.
 */
let peakAt: string | null = null;

/**
 * Transactions currently open.
 *
 * Counted separately because a transaction *reserves* one of the `POOL_MAX`
 * connections for its whole lifetime rather than queueing for one — so
 * `inFlight` alone can read zero while every slot is held, which is exactly the
 * misattribution these counters exist to prevent. See `instrumentClient()`.
 */
let openTransactions = 0;

/** Latched by the ceiling warning in `track()`, so saturation is one line. */
let atCeiling = false;

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
  /** Admitted work whose reply did not come after its cancel; their connections are gone. */
  lost: number;
  admitMax: number;
};

/** For `/api/health`, which is the one caller that should say this out loud. */
export function poolPressure(): PoolPressure {
  const gate = pool ? gateOf(pool) : null;
  return {
    name: pool ? poolName(pool) : null,
    inFlight,
    transactions: openTransactions,
    peak: peakInFlight,
    peakAt,
    max: POOL_MAX,
    admitted: gate?.admitted ?? 0,
    waiting: gate?.queue.length ?? 0,
    lost: gate?.lost ?? 0,
    admitMax: ADMIT_MAX,
  };
}

/**
 * Every pool in this process, the other bundled copy's included.
 *
 * `poolPressure()` alone describes whichever copy of this module answers it —
 * for `/api/health` the route handlers' pool, while the pool that froze on
 * 2026-09-08 and again on 2026-10-11 was the one pages use.
 */
export function allPoolPressures(): PoolPressure[] {
  return [...(globalThis.__shipbluPools?.values() ?? [])].map((read) => read());
}

/**
 * One handle's gate, for the tests that drive a pool of their own through a
 * proxy: `poolPressure()` describes only the pool `getSql()` opened.
 */
export function gateState(
  handle: object,
): { admitted: number; waiting: number; lost: number; limit: number } | null {
  const gate = gateOf(handle);
  return gate
    ? { admitted: gate.admitted, waiting: gate.queue.length, lost: gate.lost, limit: gate.limit }
    : null;
}

/**
 * The completion hooks postgres.js calls on a query, the dispatch it calls to
 * hand the query to the pool, and the cancel primitive. They are instance
 * properties assigned in its `Query` constructor, not part of its public types,
 * so `track()` below declares the shape it wraps and `db/client.test.ts`
 * asserts the wrapping still takes effect — a library upgrade that renamed one
 * would otherwise silently stop bounding anything.
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
  /** Set by postgres.js's cancel on a query it has not yet sent. */
  cancelled?: unknown;
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

/**
 * One pool's admission gate: `ADMIT_MAX` places, and a line for the rest.
 *
 * Kept on the pool handle rather than in this module, so a dev hot reload that
 * adopts the pool off `globalThis` adopts its gate with it: two gates in front
 * of one pool would each admit their full quota.
 */
type Gate = {
  limit: number;
  /** Queries and transactions holding a place, lost ones included. */
  admitted: number;
  /** Of `admitted`, those whose reply did not come after their cancel. */
  lost: number;
  /** Each returns whether it used the place it was given. */
  queue: Array<() => boolean>;
};

const GATE = Symbol.for('shipblu.db.gate');
const NAME = Symbol.for('shipblu.db.name');
const INSTRUMENTED = Symbol.for('shipblu.db.instrumented');

type Marked = {
  [GATE]?: Gate;
  [NAME]?: string;
  [INSTRUMENTED]?: true;
};

function gateOf(handle: object): Gate | null {
  return (handle as Marked)[GATE] ?? null;
}

function poolName(handle: object): string {
  const marked = handle as Marked;
  if (!marked[NAME]) {
    globalThis.__shipbluPoolCount = (globalThis.__shipbluPoolCount ?? 0) + 1;
    marked[NAME] = `pool ${globalThis.__shipbluPoolCount}`;
  }
  return marked[NAME];
}

function admit(gate: Gate, start: () => boolean): void {
  gate.queue.push(start);
  pump(gate);
}

function pump(gate: Gate): void {
  while (gate.admitted < gate.limit && gate.queue.length > 0) {
    const start = gate.queue.shift()!;
    gate.admitted += 1;
    // A query cancelled while it waited gives its place straight back.
    if (!start()) gate.admitted -= 1;
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

// --- Tracking one query -----------------------------------------------------

type TrackOptions = {
  /** Null for no deadline: the caller bounds it, as the health probes do. */
  timeoutMs: number | null;
  /** How long after its cancel the query is given up on. */
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
  /** The statement was given up on: its connection is waiting for a reply. */
  lost: (error: Error) => void;
  /** The reply to a statement given up on came after all. */
  recovered: () => void;
};

/** What `track()` hands back besides the query. */
type Tracked = {
  /** Cancels the query, and gives up on it if the cancel brings no answer. */
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
 * the CPU idles. That is the whole of the 2026-09-08 outage: requests queued
 * from 20 seconds to 40 minutes behind ten busy slots while every external
 * signal said the database was healthy. With the gate in front, the queue that
 * fills is the gate's, and a query waiting there is one the cancel removes and
 * rejects with `57014` — postgres.js's own branch for a query it has not sent.
 *
 * For a query already sent, the cancel opens a *separate* socket to send a
 * protocol CancelRequest, which is what makes it work at all when the pool is
 * the thing that is exhausted. It goes through `cancelQuietly()` rather than the
 * library's own `cancel()`, for the reason stated there. If no answer comes
 * `LOST_AFTER_CANCEL_MS` after it, the query is rejected here instead and its
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
 */
function track<T>(query: T, options: TrackOptions): Tracked {
  const settleable = query as T & Settleable;
  const { gate, timeoutMs, lostAfterMs, txn } = options;

  inFlight += 1;
  if (inFlight > peakInFlight) {
    peakInFlight = inFlight;
    peakAt = new Date().toISOString();
  }

  // Latched on the way up rather than tested on every query. As a level test
  // this logged once per `client.unsafe()` for as long as the pressure lasted —
  // thousands of identical lines over the fifty minutes of §62, pushing the one
  // useful signal out of Render's retention, which is the opposite of what it
  // is for. Re-armed on the way down, so a saturation event is one line and its
  // recovery is another.
  if (inFlight >= POOL_MAX && !atCeiling) {
    atCeiling = true;
    log.warn(`${inFlight} queries in flight against max ${POOL_MAX}${gateLine()}`);
  }

  /** Our accounting has run: the caller has its answer or its error. */
  let settled = false;
  /** Holding a place at the gate. */
  let admitted = false;
  /** Given up on after its cancel, with its place kept. */
  let lost = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineTimer);
    clearTimeout(lostTimer);
    inFlight -= 1;
    if (atCeiling && inFlight < POOL_MAX) {
      atCeiling = false;
      log.warn(`pool pressure cleared, ${inFlight} in flight${gateLine()}`);
    }
  };

  let answeredOnce = false;

  /**
   * postgres.js has answered: the one thing that proves the connection is free
   * again. Once only, because postgres.js can settle a query twice — a late
   * reply to a query already rejected here, or its own cancel racing an answer.
   */
  const answered = () => {
    if (answeredOnce) return;
    answeredOnce = true;
    if (lost) txn?.recovered();
    if (!admitted || !gate) return;
    admitted = false;
    if (lost) {
      gate.lost -= 1;
      log.warn(`a lost connection answered after all${gateLine()}`);
    }
    release(gate);
  };

  const { resolve, reject } = settleable;
  settleable.resolve = (value) => (answered(), finish(), resolve.call(settleable, value));
  settleable.reject = (error) => (answered(), finish(), reject.call(settleable, error));

  const giveUp = () => {
    if (settled) return;
    lost = true;
    if (admitted && gate) gate.lost += 1;
    const error = Object.assign(
      new Error(
        `query had no answer ${lostAfterMs}ms after its cancel; its connection is treated as lost`,
      ),
      // `query_canceled`, as every other way a query ends here is: to a caller
      // this is a statement that was cancelled, whatever happened to the reply.
      { code: '57014' },
    );
    log.warn(`a query had no answer after its cancel${gateLine()}`);
    finish();
    // The library's own reject, not the wrapper: the wrapper would give the
    // place back as though the connection had answered.
    reject.call(settleable, error);
    txn?.lost(error);
  };

  const abandon = () => {
    if (settled) return;
    cancelQuietly(settleable);
    // A query the cancel removed from a queue has settled by now.
    if (settled) return;
    lostTimer = setTimeout(giveUp, lostAfterMs);
  };

  if (timeoutMs !== null) deadlineTimer = setTimeout(abandon, timeoutMs);

  if (gate && typeof settleable.handler === 'function') {
    const dispatch = settleable.handler;
    settleable.handler = (self) => {
      admit(gate, () => {
        // Cancelled, or given up on, while it waited: nothing to send.
        if (settled || settleable.cancelled) return false;
        admitted = true;
        dispatch.call(settleable, self);
        return true;
      });
    };
  }

  return { abandon };

  function gateLine(): string {
    if (!gate || !pool) return '';
    return ` (${poolName(pool)}: ${gate.admitted - gate.lost} running, ${gate.queue.length} waiting, ${gate.lost} lost of ${gate.limit})`;
  }
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
 * transaction like any statement inside it.
 */
let beginning: { txn: TransactionWatch | undefined } | null = null;

export type InstrumentOptions = {
  /** Put the handle's queries and transactions behind an admission gate of this size. */
  admit?: number;
  /** How long after its cancel a query is given up on; `LOST_AFTER_CANCEL_MS` unless a test says. */
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
  const limits = { timeoutMs, lostAfterMs: options.lostAfterMs ?? LOST_AFTER_CANCEL_MS };
  return instrumentWith(client, limits, options.admit ? newGate(client, options.admit) : null);
}

function newGate(client: unknown, limit: number): Gate {
  const marked = client as Marked;
  marked[GATE] ??= { limit, admitted: 0, lost: 0, queue: [] };
  return marked[GATE];
}

function instrumentWith<T>(
  client: T,
  limits: Limits,
  gate: Gate | null,
  txn?: TransactionWatch,
): T {
  const handle = client as unknown as Instrumentable & Marked;
  if (handle[INSTRUMENTED]) return client;
  handle[INSTRUMENTED] = true;

  const native = handle.unsafe.bind(handle);
  handle.unsafe = (...args: unknown[]) => {
    const opening = beginning;
    const query = native(...args);
    track(query, opening ? { ...limits, gate: null, txn: opening.txn } : { ...limits, gate, txn });
    return query;
  };

  const nativeBegin = handle.begin;
  if (nativeBegin) {
    handle.begin = (...args: unknown[]) => beginBehind(gate, limits, nativeBegin, handle, args);
  }

  const nativeSavepoint = handle.savepoint;
  if (nativeSavepoint) {
    handle.savepoint = (...args: unknown[]) =>
      nativeSavepoint.apply(handle, instrumentScope(args, limits, false, txn));
  }

  return client;
}

/**
 * `begin()`, holding one place at the gate for the transaction's whole life.
 *
 * Bounded twice. A transaction still waiting at the gate after `timeoutMs` is
 * refused with `57014`, as a waiting query is. And one whose statement is given
 * up on is rejected then, rather than when postgres.js's own `ROLLBACK` comes
 * back: that is written onto the same connection behind the statement that
 * never answered, so it never does.
 *
 * The place itself is kept, and counted lost, until postgres.js has settled the
 * transaction *and* every statement given up on has been answered. Either alone
 * is not proof the connection is free: a `BEGIN` rejected here settles the
 * transaction at once while its reply is still owed, and a late reply to a
 * statement leaves the `ROLLBACK` still to run.
 */
function beginBehind(
  gate: Gate | null,
  limits: Limits,
  nativeBegin: (...args: unknown[]) => unknown,
  handle: object,
  args: unknown[],
): Promise<unknown> {
  const start = (txn?: TransactionWatch) => {
    beginning = { txn };
    try {
      return Promise.resolve(nativeBegin.apply(handle, instrumentScope(args, limits, true, txn)));
    } finally {
      beginning = null;
    }
  };

  if (!gate) return start();

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      finish();
    };

    const waitTimer = setTimeout(
      () =>
        settle(() =>
          reject(
            Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
          ),
        ),
      limits.timeoutMs,
    );

    admit(gate, () => {
      if (settled) return false;
      clearTimeout(waitTimer);

      /** Statements given up on whose reply has not come. */
      let unanswered = 0;
      let countedLost = false;
      let nativeSettled = false;
      let released = false;

      const releaseWhenFree = () => {
        if (released || !nativeSettled || unanswered > 0) return;
        released = true;
        if (countedLost) {
          gate.lost -= 1;
          log.warn('a lost transaction connection answered after all');
        }
        release(gate);
      };

      const txn: TransactionWatch = {
        lost: (error) => {
          unanswered += 1;
          if (!countedLost) {
            countedLost = true;
            gate.lost += 1;
          }
          settle(() => reject(error));
        },
        recovered: () => {
          unanswered -= 1;
          releaseWhenFree();
        },
      };

      start(txn)
        .then(
          (value) => settle(() => resolve(value)),
          (error: unknown) => settle(() => reject(error)),
        )
        .finally(() => {
          nativeSettled = true;
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
 * not count as a second open transaction.
 */
function instrumentScope(
  args: unknown[],
  limits: Limits,
  counts: boolean,
  txn: TransactionWatch | undefined,
): unknown[] {
  const last = args.length - 1;
  const body = args[last];
  if (typeof body !== 'function') return args;

  const run = body as (client: unknown) => unknown;
  const wrapped = async (client: unknown) => {
    if (counts) openTransactions += 1;
    try {
      return await run(instrumentWith(client, limits, null, txn));
    } finally {
      if (counts) openTransactions -= 1;
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
  // that would lose `.values()` and `.cursor()`.
  instrumentClient(pool, env().DB_QUERY_TIMEOUT_MS, { admit: ADMIT_MAX });

  // Under its name, so a dev reload replaces this copy's entry rather than
  // adding one beside it.
  globalThis.__shipbluPools ??= new Map();
  globalThis.__shipbluPools.set(poolName(pool), poolPressure);

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
 * connection whenever the pool is full.
 */
export function databaseProbe(): { done: Promise<unknown>; abandon: () => void } {
  const sql = getSql();
  const query = sql`select 1`;
  const { abandon } = track(query, {
    timeoutMs: null,
    lostAfterMs: LOST_AFTER_CANCEL_MS,
    gate: gateOf(sql),
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
 * and one Render eventually kills.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    globalThis.__shipbluPools?.delete(poolName(pool));
    await pool.end({ timeout: 5 });
    pool = undefined;
    globalThis.__shipbluSql = undefined;
  }
}
